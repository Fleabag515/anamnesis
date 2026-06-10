#!/usr/bin/env node
/**
 * proxy.js — Anamnesis main server.
 *
 * Works with any OpenAI-compatible backend (llama-server, Ollama /v1,
 * LM Studio, koboldcpp, OpenAI itself, …). Set upstream.baseUrl +
 * upstream.apiKey in config.json.
 *
 * Per-request pipeline (POST /…/chat/completions):
 *   1. Persist NEW turns synchronously — user messages, assistant tool_calls,
 *      and tool results (deduped across the agentic loop's replays). Oversized
 *      tool results are spilled to the ArtifactStore immediately.
 *   2. Working-set assembly (selector v2): watermark-driven, structure-aware
 *      eviction against the *discovered* context window (governor).
 *   3. Inject the `recall` tool when the client is agentic (sent tools).
 *   4. Forward to upstream. Recall calls are resolved by the proxy itself and
 *      looped upstream (bounded hops) — the client never sees them.
 *      - streaming    : recall tool-call deltas are filtered out of the SSE
 *        stream; recall-only responses loop transparently mid-stream.
 *      - non-streaming: classified and looped before responding.
 *   5. Persist the assistant turn + kick off background extraction.
 *   6. On sustained pressure (aggressive/emergency watermarks), ask an
 *      elastic upstream (the Pleiades engine) to upshift via POST /resize.
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
const crypto = require('crypto');

const {
  expandHome,
  extractContentText,
  getSessionKey,
  buildUpstreamHeaders,
  stripThinkingTokens,
  makeStreamingThinkingFilter,
} = require('./lib/proxy-helpers.js');
const {
  RECALL_TOOL_NAME,
  withRecallTool,
  collectToolCalls,
  classifyResponse,
  makeToolCallAccumulator,
  recallExchangeMessages,
} = require('./lib/recall-tool.js');
const log = require('./lib/logger.js').make('anamnesis');

const brain = require('./lib/brain.js');
const HistoryStore = require('./history.js');
const embedder = require('./embedder.js'); // singleton
const Selector = require('./selector.js');
const Extractor = require('./extractor.js');
const ForesightExtractor = require('./foresight.js');
const PersonaManager = require('./persona.js');
const Consolidator = require('./consolidator.js');
const ContextGovernor = require('./governor.js');
const ArtifactStore = require('./artifacts.js');

function loadConfig() {
  return expandHome(JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')));
}

async function start(config = loadConfig()) {
  brain.init(config); // start model download/load in background; chat() calls queue until ready

  const history = new HistoryStore(config.history.dbPath);
  const persona = new PersonaManager(config, history);
  await persona.init();
  const governor = new ContextGovernor(config);
  governor.init().catch((e) => log.warn('governor probe:', e.message));
  const artifacts = new ArtifactStore(config, history, embedder);
  const selector = new Selector(config, history, embedder, persona, governor, artifacts);
  const extractor = new Extractor(config, history, embedder);
  const foresightExtractor = new ForesightExtractor(config, history);
  const consolidator = new Consolidator(config, history, embedder);

  const recallEnabled = config.artifacts?.recallTool ?? true;
  const maxRecallHops = config.artifacts?.maxRecallHops ?? 4;
  const spillTokens = config.artifacts?.spillTokens ?? 1500;

  const pruned = history.prune(config.history.maxAgeDays);
  if (pruned > 0) log.info(`pruned ${pruned} old turns`);

  // Pick up turns that crashed mid-extraction in a previous session.
  extractor.processBacklog().catch((e) => log.warn('backlog (extractor):', e.message));
  foresightExtractor.processBacklog().catch((e) => log.warn('backlog (foresight):', e.message));

  consolidator.start(config.memory.consolidationIntervalMs);

  // ─── Turn ingestion (deduped across agentic replays) ─────────────────────

  const seenBySession = new Map(); // sessionKey -> Set<hash>
  const pendingRecall = new Map(); // sessionKey -> messages[] to splice next request

  function seenSet(sessionKey) {
    let set = seenBySession.get(sessionKey);
    if (!set) {
      if (seenBySession.size > 50) {
        seenBySession.delete(seenBySession.keys().next().value);
      }
      set = new Set();
      seenBySession.set(sessionKey, set);
    }
    return set;
  }

  function msgHash(m) {
    const body =
      `${m.role}|${m.tool_call_id ?? ''}|` +
      (Array.isArray(m.tool_calls) ? JSON.stringify(m.tool_calls) : '') +
      extractContentText(m.content);
    return crypto.createHash('sha1').update(body).digest('base64').slice(0, 20);
  }

  /**
   * Persist every NEW message in the incoming array. Agentic clients resend
   * the whole transcript each step; the hash set makes ingestion idempotent
   * (this also fixes duplicate user-turn rows on every loop iteration).
   */
  async function persistIncoming(sessionKey, messages) {
    const seen = seenSet(sessionKey);
    if (seen.size > 8000) seen.clear(); // crude cap; turns are already stored

    // tool_call_id -> function name, for labelling results
    const callNames = new Map();
    for (const m of messages) {
      for (const c of m?.tool_calls ?? []) {
        if (c?.id) callNames.set(c.id, c?.function?.name ?? '');
      }
    }

    for (const m of messages) {
      if (!m || m.role === 'system') continue;
      const isToolCall = m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length;
      const isToolResult = m.role === 'tool';
      const isUser = m.role === 'user';
      if (!isUser && !isToolCall && !isToolResult) continue; // plain assistant turns are stored at generation time

      const h = msgHash(m);
      if (seen.has(h)) continue;
      seen.add(h);

      const text = isToolCall
        ? [extractContentText(m.content), JSON.stringify(m.tool_calls)].filter(Boolean).join('\n')
        : extractContentText(m.content);
      if (!text) continue;

      const est = governor.estimate(text);
      const kind = isToolCall ? 'tool_call' : isToolResult ? 'tool_result' : 'chat';
      const toolName = isToolResult ? (callNames.get(m.tool_call_id) ?? '') : '';

      if (isUser) {
        // Same sync embed as ever — the selector queries against it next step.
        const vec = await embedder.embed(text.slice(0, 2000)).catch(() => null);
        history.insertTurn(sessionKey, 'user', text, vec, est, embedder.model);
        continue;
      }

      const turnId = history.insertTurn(sessionKey, m.role, text, null, est, null, {
        kind,
        toolName,
        toolCallId: m.tool_call_id ?? (isToolCall ? (m.tool_calls[0]?.id ?? '') : ''),
      });

      // Oversized tool results become artifacts right away, so recall works
      // even before any eviction has happened.
      if (isToolResult && est >= spillTokens) {
        artifacts.spill(sessionKey, { toolName, content: text, tokenEst: est, turnId });
      }

      // Embed in the background — selection doesn't need these vectors immediately.
      if (text.length <= 8000) {
        setImmediate(async () => {
          const vec = await embedder.embed(text.slice(0, 2000)).catch(() => null);
          if (vec) history.updateTurnEmbedding(turnId, vec, embedder.model);
        });
      }
    }
  }

  // ─── Upstream wiring ──────────────────────────────────────────────────────

  function upstreamUrl(reqPath) {
    const upUrl = new URL(config.upstream.baseUrl);
    return {
      upUrl,
      lib: upUrl.protocol === 'https:' ? https : http,
      port: upUrl.port || (upUrl.protocol === 'https:' ? 443 : 80),
      path: (() => {
        const base = upUrl.pathname.replace(/\/$/, '');
        // If the baseUrl already ends in /v1, strip /v1 from reqPath to avoid doubling
        const req = base.endsWith('/v1') ? reqPath.replace(/^\/v1/, '') : reqPath;
        return base + req;
      })(),
    };
  }

  /**
   * Pipe upstream response to `onChunk` (which decides what reaches the
   * client). Resolves with the upstream status when the stream ends.
   */
  function streamUpstream(reqPath, method, headers, body, onChunk, onHead) {
    return new Promise((resolve, reject) => {
      const { upUrl, lib, port, path: outPath } = upstreamUrl(reqPath);
      const upReq = lib.request(
        { hostname: upUrl.hostname, port, path: outPath, method, headers },
        (upRes) => {
          if (onHead) onHead(upRes);
          upRes.on('data', (chunk) => {
            try {
              onChunk(chunk);
            } catch (e) {
              log.warn('onChunk error:', e.message);
            }
          });
          upRes.on('end', () => resolve({ status: upRes.statusCode }));
          upRes.on('error', reject);
        }
      );
      upReq.on('error', reject);
      upReq.setTimeout(1800000, () => upReq.destroy(new Error('upstream timeout')));
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
      upReq.setTimeout(1800000, () => upReq.destroy(new Error('upstream timeout')));
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
        const est = governor.estimate(content);
        history.insertTurn(sessionKey, 'assistant', content, vec, est, embedder.model);
        extractor.processBatch().catch((e) => log.warn('extractor:', e.message));
        foresightExtractor.processBatch().catch((e) => log.warn('foresight:', e.message));
        persona.observeResponse(sessionKey, null, content);
      } catch (e) {
        log.warn('recordAssistantTurn:', e.message);
      }
    });
  }

  /** Resolve every recall call in an assistant message → tool messages. */
  async function resolveRecalls(sessionKey, assistantMessage) {
    const calls = collectToolCalls(assistantMessage).filter((c) => c.name === RECALL_TOOL_NAME);
    const results = [];
    for (const c of calls) {
      const text = await artifacts.recall(sessionKey, c.args);
      results.push({ id: c.id, text });
    }
    return recallExchangeMessages(assistantMessage, results);
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
          artifacts: history.artifactStats('default'),
          context: governor.describe(),
          upstream: config.upstream.baseUrl,
          embedding_model: brain.embeddingModel(),
        })
      );
    }

    const reqChunks = [];
    req.on('data', (d) => reqChunks.push(d));
    req.on('end', async () => {
      const rawBody = Buffer.concat(reqChunks);
      try {
        await handleRequest(req, res, rawBody);
      } catch (err) {
        log.error('unhandled request error (prevented crash):', err.message, err.stack?.split('\n')[1] ?? '');
        if (!res.headersSent) {
          try { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'proxy internal error' })); } catch {}
        }
      }
    });
  });

  async function handleRequest(req, res, rawBody) {

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

        // Recall exchanges the proxy resolved while the client was busy with
        // its own tool calls (mixed batches) get spliced back in here.
        const splice = pendingRecall.get(sessionKey);
        if (splice?.length) {
          parsed.messages = [...parsed.messages, ...splice];
          pendingRecall.delete(sessionKey);
        }

        // 1. Persist new turns (user, tool calls, tool results) — idempotent.
        try {
          await persistIncoming(sessionKey, parsed.messages);
        } catch (e) {
          log.warn('persistIncoming:', e.message);
        }

        // 2. Working-set assembly.
        let selectedMessages = parsed.messages;
        let assessment = null;
        try {
          const sel = await selector.select(sessionKey, parsed.messages);
          selectedMessages = sel.messages;
          assessment = sel.assessment;
        } catch (err) {
          log.error('selector error, falling back to original messages:', err.message);
        }
        if (assessment && ContextGovernor.levelAtLeast(assessment.level, 'aggressive')) {
          governor.signalPressure();
        }

        // 3. Rewrite + forward.
        const rewritten = { ...parsed, messages: selectedMessages };
        const agentic = Array.isArray(parsed.tools);
        if (agentic && recallEnabled) rewritten.tools = withRecallTool(parsed.tools);
        // Override model name if upstream.model is set in config (e.g. Ollama needs exact model name).
        if (config.upstream.model) rewritten.model = config.upstream.model;
        if (config.upstream.disableThinking) {
          // Thinking management strategy:
          // - Do NOT strip tools/tool_choice — Mark needs full tool access to act autonomously.
          // - Let the server's built-in reasoning extractor handle thinking tokens:
          //   thinking goes into `reasoning_content` (ephemeral, never stored in DB),
          //   leaving `content` clean. Thinking is free and doesn't pollute future context.
          // - Boost max_tokens so thinking budget + actual response both fit within the
          //   completion window. completion_tokens counts BOTH thinking + content tokens.
          //   THINKING_OVERHEAD gives the model room for deep reasoning chains.
          const THINKING_OVERHEAD = 4000; // model self-terminates well before this
          const clientBudget = rewritten.max_tokens ?? 600;
          rewritten.max_tokens = clientBudget + THINKING_OVERHEAD;
        }
        log.debug('MSGS OUT: ' + JSON.stringify(selectedMessages.map(m => m.role + ':' + (typeof m.content === 'string' ? m.content : JSON.stringify(m.content) ?? '').slice(0,80))));

        const headers = buildUpstreamHeaders(req.headers, {
          upstreamApiKey: config.upstream.apiKey,
        });
        const sendBody = (obj) => {
          const b = Buffer.from(JSON.stringify(obj));
          headers['Content-Length'] = Buffer.byteLength(b);
          return b;
        };

        if (streaming) {
          await streamWithRecall(req, res, sessionKey, rewritten, headers, sendBody, agentic);
          return;
        }

        // ── Non-streaming, with proxy-side recall hops ─────────────────────
        let hopMessages = rewritten.messages;
        let upRes = null;
        for (let hop = 0; hop <= maxRecallHops; hop++) {
          try {
            upRes = await bufferedForward(
              req.url, req.method, headers, sendBody({ ...rewritten, messages: hopMessages })
            );
          } catch (err) {
            log.error('upstream error:', err.message);
            res.writeHead(502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: err.message }));
          }
          if (!agentic || !recallEnabled || upRes.status !== 200 || hop === maxRecallHops) break;
          let msg;
          try {
            msg = JSON.parse(upRes.body.toString())?.choices?.[0]?.message;
          } catch {
            break;
          }
          if (!msg || classifyResponse(msg) !== 'recall-only') break;
          log.info(`recall hop ${hop + 1}: resolving ${msg.tool_calls.length} call(s) proxy-side`);
          hopMessages = [...hopMessages, ...(await resolveRecalls(sessionKey, msg))];
        }

        // Strip thinking tokens from the response before sending to client AND before storing.
        let clientBody = upRes.body;
        let storedContent = '';
        try {
          const upParsed = JSON.parse(upRes.body.toString());
          if (upParsed.usage?.prompt_tokens && assessment) {
            governor.observePromptUsage(assessment.used, upParsed.usage.prompt_tokens);
          }
          const rawContent = upParsed.choices?.[0]?.message?.content ?? '';
          storedContent = stripThinkingTokens(rawContent);
          if (rawContent !== storedContent) {
            // Rewrite body with stripped content so client never sees thinking tokens
            upParsed.choices[0].message.content = storedContent;
            clientBody = Buffer.from(JSON.stringify(upParsed));
          }
        } catch { /* non-JSON — pass through as-is */ }
        // Strip transfer-encoding when we're rewriting the body; set fresh Content-Length.
        const outHeaders = { ...upRes.headers };
        delete outHeaders['transfer-encoding'];
        delete outHeaders['content-encoding']; // body is already decoded by bufferedForward
        outHeaders['content-length'] = Buffer.byteLength(clientBody);
        res.writeHead(upRes.status, outHeaders);
        res.end(clientBody);

        if (storedContent) recordAssistantTurn(sessionKey, storedContent);
        return;
      }

      passthrough(req, res, rawBody);
  }  // end handleRequest

  /**
   * Streaming forward with transparent recall hops.
   *
   * Strategy: stream frames through to the client, but FILTER OUT tool-call
   * deltas that belong to the injected recall tool (re-indexing the rest).
   * The finish frame + [DONE] are held back until the stream ends:
   *   - recall-only response → resolve, hop again on the SAME client stream
   *   - mixed → resolve recalls, stash for the next request, release tail
   *   - anything else → release tail untouched
   */
  async function streamWithRecall(req, res, sessionKey, rewritten, headers, sendBody, agentic) {
    const useRecall = agentic && recallEnabled;
    const filteredWrite = config.upstream.disableThinking
      ? makeStreamingThinkingFilter(res)
      : (c) => res.write(c);

    let headSent = false;
    let hopMessages = rewritten.messages;
    let lastContent = '';

    for (let hop = 0; hop <= maxRecallHops; hop++) {
      const acc = makeToolCallAccumulator();
      const recallIdx = new Set(); // tool_call indexes that belong to recall
      let held = ''; // finish frame(s) + [DONE], pending the end-of-stream decision
      let sseBuf = '';

      const emitFrame = (frame) => {
        if (!useRecall) return void filteredWrite(frame + '\n\n');
        // Decide per-frame: drop recall deltas, re-index others, hold finish/DONE.
        const lines = frame.split('\n');
        const out = [];
        let holdThis = false;
        for (const line of lines) {
          if (!line.startsWith('data:')) {
            out.push(line);
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            holdThis = true;
            out.push(line);
            continue;
          }
          let j;
          try {
            j = JSON.parse(payload);
          } catch {
            out.push(line);
            continue;
          }
          const choice = j?.choices?.[0];
          if (!choice) {
            out.push(line);
            continue;
          }
          if (choice.finish_reason) holdThis = true;
          const deltas = choice.delta?.tool_calls;
          if (Array.isArray(deltas)) {
            const kept = [];
            for (const tc of deltas) {
              const idx = tc.index ?? 0;
              if (tc.function?.name === RECALL_TOOL_NAME) recallIdx.add(idx);
              if (recallIdx.has(idx)) continue; // suppress recall deltas
              const shift = [...recallIdx].filter((r) => r < idx).length;
              kept.push({ ...tc, index: idx - shift });
            }
            if (!kept.length && !choice.delta?.content && !choice.finish_reason) continue; // pure-recall frame
            choice.delta = { ...choice.delta, tool_calls: kept.length ? kept : undefined };
            if (!kept.length) delete choice.delta.tool_calls;
            out.push('data: ' + JSON.stringify(j));
            continue;
          }
          out.push(line);
        }
        if (!out.length) return;
        const text = out.join('\n') + '\n\n';
        if (holdThis) held += text;
        else filteredWrite(text);
      };

      const result = await streamUpstream(
        req.url,
        req.method,
        headers,
        sendBody({ ...rewritten, messages: hopMessages }),
        (chunk) => {
          acc.feed(chunk);
          if (!useRecall) return void filteredWrite(chunk);
          sseBuf += chunk.toString('utf8');
          const frames = sseBuf.split(/\n\n/);
          sseBuf = frames.pop();
          for (const f of frames) emitFrame(f);
        },
        (upRes) => {
          if (headSent) return;
          headSent = true;
          const outHeaders = { ...upRes.headers };
          delete outHeaders['transfer-encoding'];
          delete outHeaders['connection'];
          delete outHeaders['content-length'];
          res.writeHead(upRes.statusCode, outHeaders);
        }
      ).catch((err) => {
        log.error('streaming upstream error:', err.message);
        if (!headSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          res.end();
        }
        return null;
      });
      if (!result) return;
      if (sseBuf) emitFrame(sseBuf);

      const msg = acc.message();
      lastContent = (lastContent + (msg.content ?? '')).trim() ? lastContent + (msg.content ?? '') : lastContent;
      const kind = useRecall ? classifyResponse(msg) : 'content';

      if (kind === 'recall-only' && hop < maxRecallHops) {
        log.info(`recall hop ${hop + 1} (streaming): resolving ${msg.tool_calls.length} call(s)`);
        hopMessages = [...hopMessages, ...(await resolveRecalls(sessionKey, msg))];
        continue; // next hop streams onto the same client response
      }
      if (kind === 'mixed') {
        // Client executes its own tools; our recall results join the next request.
        const exchange = await resolveRecalls(sessionKey, {
          ...msg,
          tool_calls: msg.tool_calls.filter((c) => c?.function?.name === RECALL_TOOL_NAME),
        });
        pendingRecall.set(sessionKey, exchange);
      }
      if (held) filteredWrite(held);
      res.end();
      break;
    }

    const strippedContent = stripThinkingTokens(lastContent);
    // Only store if there's real content — guards against storing null/'[]'/
    // tool-call residue or partial chunks from dropped connections.
    if (strippedContent && strippedContent.trim().length >= 4) {
      recordAssistantTurn(sessionKey, strippedContent);
    }
  }

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

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`port ${config.proxy.port} already in use — stop the other instance first`);
      }
      reject(err);
    });
    server.listen(config.proxy.port, config.proxy.host, () => {
      log.info(`listening on ${config.proxy.host}:${config.proxy.port}`);
      log.info(`upstream: ${config.upstream.baseUrl}`);
      log.info(
        `context: governed (probing upstream for n_ctx; reserve ${governor.completionReserve}) | ` +
          `pinned: ${config.context?.pinnedExchanges ?? config.context?.recencyTurns ?? 3} exchanges | ` +
          `recall tool: ${recallEnabled ? 'on' : 'off'}`
      );
      resolve();
    });
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
    // Do NOT call process.exit() here. When running inside the daemon (in-process),
    // exiting would kill the entire daemon process. Callers that want process exit
    // (standalone mode) do it themselves via the signal handlers below.
  }

  if (require.main === module) {
    process.on('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)));
    process.on('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)));
  }

  return { server, history, shutdown };
}

if (require.main === module) start();

module.exports = { start, loadConfig };
