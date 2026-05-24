#!/usr/bin/env node
/**
 * proxy.js — Anamnesis main server.
 *
 * Works with any OpenAI-compatible backend (llama-server, Ollama /v1,
 * LM Studio, koboldcpp, OpenAI itself, …). Set upstream.baseUrl +
 * upstream.apiKey in config.json.
 *
 * Per-request pipeline (POST /…/chat/completions):
 *   1. Persist user turn synchronously  (survives any subsequent crash)
 *   2. Scene-guided context selection   (drops in <memory>/<foresight> blocks)
 *   3. Forward to upstream
 *      - streaming    : pipe each SSE chunk through to the client and tee
 *                       a copy into an accumulator that reconstructs the
 *                       final assistant content from delta frames.
 *      - non-streaming: buffer upstream, return, then parse content.
 *   4. Persist the assistant turn + kick off background extraction
 *      (memcell + foresight, both non-blocking).
 *
 * Graceful shutdown (SIGTERM/SIGINT):
 *   - Stop the consolidator timer
 *   - Wait up to 15s for in-flight extraction
 *   - Close the SQLite handle
 */

const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');

const {
  expandHome,
  extractContentText,
  getSessionKey,
  buildUpstreamHeaders,
  makeSseAccumulator,
} = require('./lib/proxy-helpers.js');
const log = require('./lib/logger.js').make('anamnesis');

const HistoryStore = require('./history.js');
const Embedder = require('./embedder.js');
const Selector = require('./selector.js');
const Extractor = require('./extractor.js');
const ForesightExtractor = require('./foresight.js');
const Consolidator = require('./consolidator.js');

function loadConfig() {
  return expandHome(JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')));
}

function start(config = loadConfig()) {
  const history = new HistoryStore(config.history.dbPath);
  const embedder = new Embedder(config.embedding.ollamaUrl, config.embedding.model);
  const selector = new Selector(config, history, embedder);
  const extractor = new Extractor(config, history, embedder);
  const foresightExtractor = new ForesightExtractor(config, history);
  const consolidator = new Consolidator(config, history, embedder);

  const pruned = history.prune(config.history.maxAgeDays);
  if (pruned > 0) log.info(`pruned ${pruned} old turns`);

  // Pick up turns that crashed mid-extraction in a previous session.
  extractor.processBacklog().catch((e) => log.warn('backlog (extractor):', e.message));
  foresightExtractor.processBacklog().catch((e) => log.warn('backlog (foresight):', e.message));

  consolidator.start(config.memory.consolidationIntervalMs);

  // ─── Upstream wiring ──────────────────────────────────────────────────────

  function upstreamUrl(reqPath) {
    const upUrl = new URL(config.upstream.baseUrl);
    return {
      upUrl,
      lib: upUrl.protocol === 'https:' ? https : http,
      port: upUrl.port || (upUrl.protocol === 'https:' ? 443 : 80),
      path: upUrl.pathname.replace(/\/$/, '') + reqPath,
    };
  }

  /**
   * Pipe upstream response straight to the client, AND tee each chunk into
   * `onChunk` so callers can rebuild assistant content for storage.
   */
  function streamThrough(reqPath, method, headers, body, clientRes, onChunk) {
    return new Promise((resolve, reject) => {
      const { upUrl, lib, port, path: outPath } = upstreamUrl(reqPath);
      const upReq = lib.request(
        { hostname: upUrl.hostname, port, path: outPath, method, headers },
        (upRes) => {
          const outHeaders = { ...upRes.headers };
          // Don't repeat hop-by-hop headers to the client.
          delete outHeaders['transfer-encoding'];
          delete outHeaders['connection'];
          clientRes.writeHead(upRes.statusCode, outHeaders);

          upRes.on('data', (chunk) => {
            clientRes.write(chunk);
            try {
              onChunk(chunk);
            } catch (e) {
              log.warn('onChunk error:', e.message);
            }
          });
          upRes.on('end', () => {
            clientRes.end();
            resolve();
          });
          upRes.on('error', (err) => {
            clientRes.end();
            reject(err);
          });
        }
      );
      upReq.on('error', (err) => {
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'Content-Type': 'application/json' });
          clientRes.end(JSON.stringify({ error: err.message }));
        } else {
          clientRes.end();
        }
        reject(err);
      });
      upReq.setTimeout(300000, () => upReq.destroy(new Error('upstream timeout')));
      upReq.write(body);
      upReq.end();
    });
  }

  function bufferedForward(reqPath, method, headers, body) {
    return new Promise((resolve, reject) => {
      const { upUrl, lib, port, path: outPath } = upstreamUrl(reqPath);
      const upReq = lib.request(
        { hostname: upUrl.hostname, port, path: outPath, method, headers },
        (upRes) => {
          const chunks = [];
          upRes.on('data', (d) => chunks.push(d));
          upRes.on('end', () =>
            resolve({
              status: upRes.statusCode,
              headers: upRes.headers,
              body: Buffer.concat(chunks),
            })
          );
          upRes.on('error', reject);
        }
      );
      upReq.on('error', reject);
      upReq.setTimeout(300000, () => upReq.destroy(new Error('upstream timeout')));
      upReq.write(body);
      upReq.end();
    });
  }

  function recordAssistantTurn(sessionKey, content) {
    if (!content) return;
    // Defer to the next tick so the client connection is fully closed first;
    // embedding + extraction never block the response.
    setImmediate(async () => {
      try {
        const vec = await embedder.embed(content.slice(0, 2000)).catch(() => null);
        const est = Math.ceil(content.length / config.context.charsPerToken);
        history.insertTurn(sessionKey, 'assistant', content, vec, est, embedder.model);
        extractor.processBatch().catch((e) => log.warn('extractor:', e.message));
        foresightExtractor.processBatch().catch((e) => log.warn('foresight:', e.message));
      } catch (e) {
        log.warn('recordAssistantTurn:', e.message);
      }
    });
  }

  // ─── Server ───────────────────────────────────────────────────────────────

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/anamnesis/status') {
      const stats = history.stats('default');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(
        JSON.stringify({
          status: 'ok',
          ...stats,
          upstream: config.upstream.baseUrl,
          embedding_model: config.embedding.model,
        })
      );
    }

    const reqChunks = [];
    req.on('data', (d) => reqChunks.push(d));
    req.on('end', async () => {
      const rawBody = Buffer.concat(reqChunks);

      if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
        let parsed;
        try {
          parsed = JSON.parse(rawBody.toString());
        } catch {
          return passthrough(req, res, rawBody);
        }
        if (!Array.isArray(parsed.messages)) return passthrough(req, res, rawBody);

        const sessionKey = getSessionKey(req.headers, config.upstream.apiKey);
        const streaming = parsed.stream === true;

        // 1. Persist user turn synchronously.
        // Content may be a string OR an array of OpenAI content-parts
        // (text + tool_result + image_url etc). Flatten before storage —
        // better-sqlite3 only binds primitives, and the selector needs a
        // string to embed.
        const userMsg = [...parsed.messages].reverse().find((m) => m.role === 'user');
        const userText = extractContentText(userMsg?.content);
        if (userText) {
          const vec = await embedder.embed(userText).catch(() => null);
          const est = Math.ceil(userText.length / config.context.charsPerToken);
          history.insertTurn(sessionKey, 'user', userText, vec, est, embedder.model);
        }

        // 2. Scene-guided context selection.
        let selectedMessages = parsed.messages;
        try {
          selectedMessages = await selector.select(sessionKey, parsed.messages);
        } catch (err) {
          log.error('selector error, falling back to original messages:', err.message);
        }

        // 3. Rewrite + forward.
        const rewritten = { ...parsed, messages: selectedMessages };
        if (config.upstream.disableThinking) {
          rewritten.chat_template_kwargs = {
            ...rewritten.chat_template_kwargs,
            enable_thinking: false,
          };
        }
        const rewrittenBody = Buffer.from(JSON.stringify(rewritten));
        const headers = buildUpstreamHeaders(req.headers, {
          upstreamApiKey: config.upstream.apiKey,
        });
        headers['Content-Length'] = Buffer.byteLength(rewrittenBody);

        if (streaming) {
          const sse = makeSseAccumulator();
          try {
            await streamThrough(req.url, req.method, headers, rewrittenBody, res, (c) =>
              sse.feed(c)
            );
          } catch (err) {
            log.error('streaming upstream error:', err.message);
            return;
          }
          recordAssistantTurn(sessionKey, sse.content);
          return;
        }

        let upRes;
        try {
          upRes = await bufferedForward(req.url, req.method, headers, rewrittenBody);
        } catch (err) {
          log.error('upstream error:', err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: err.message }));
        }
        res.writeHead(upRes.status, upRes.headers);
        res.end(upRes.body);

        try {
          const upParsed = JSON.parse(upRes.body.toString());
          const content = upParsed.choices?.[0]?.message?.content ?? '';
          recordAssistantTurn(sessionKey, content);
        } catch {
          /* non-JSON response; nothing to persist */
        }
        return;
      }

      passthrough(req, res, rawBody);
    });
  });

  async function passthrough(req, res, body) {
    const headers = buildUpstreamHeaders(req.headers, { upstreamApiKey: config.upstream.apiKey });
    headers['Content-Length'] = Buffer.byteLength(body);
    try {
      const upRes = await bufferedForward(req.url, req.method, headers, body);
      res.writeHead(upRes.status, upRes.headers);
      res.end(upRes.body);
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  }

  server.listen(config.proxy.port, config.proxy.host, () => {
    log.info(`listening on ${config.proxy.host}:${config.proxy.port}`);
    log.info(`upstream: ${config.upstream.baseUrl}`);
    log.info(`extraction model: ${config.extraction.model}`);
    log.info(
      `token budget: ${config.context.tokenBudget} | recency: ${config.context.recencyTurns} turns | slots: ${config.context.rotatingSlots}`
    );
  });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down gracefully...`);
    consolidator.stop();
    server.close();
    await Promise.all([extractor.flushInFlight(), foresightExtractor.flushInFlight()]);
    try {
      history.close();
    } catch {
      /* already closed */
    }
    log.info('shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return { server, history, shutdown };
}

if (require.main === module) start();

module.exports = { start, loadConfig };
