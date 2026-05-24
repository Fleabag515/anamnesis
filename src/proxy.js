#!/usr/bin/env node
/**
 * proxy.js — Anamnesis main server
 *
 * Works with any OpenAI-compatible backend:
 *   llama-server, Ollama (/v1), LM Studio, koboldcpp, OpenAI, etc.
 *   Just set upstream.baseUrl + upstream.apiKey in config.json.
 *
 * Startup sequence:
 *   1. Process backlog of unextracted turns from previous sessions
 *   2. Start consolidation timer
 *   3. Begin listening
 *
 * Per-request pipeline:
 *   1. Store user turn (synchronous — survives any crash)
 *   2. Scene-guided context selection
 *   3. Forward to upstream
 *   4. Return response to client
 *   5. Store assistant turn + trigger background MemCell extraction (non-blocking)
 *
 * Graceful shutdown (SIGTERM/SIGINT):
 *   - Wait for in-flight extraction to finish (max 15s)
 *   - Then exit cleanly
 */

const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const config       = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
const HistoryStore = require('./history.js');
const Embedder     = require('./embedder.js');
const Selector     = require('./selector.js');
const Extractor          = require('./extractor.js');
const ForesightExtractor = require('./foresight.js');
const Consolidator       = require('./consolidator.js');

const history      = new HistoryStore(config.history.dbPath);
const embedder     = new Embedder(config.embedding.ollamaUrl, config.embedding.model);
const selector     = new Selector(config, history, embedder);
const extractor          = new Extractor(config, history, embedder);
const foresightExtractor = new ForesightExtractor(config, history);
const consolidator       = new Consolidator(config, history, embedder);

// Prune old turns
const pruned = history.prune(config.history.maxAgeDays);
if (pruned > 0) console.log(`[anamnesis] pruned ${pruned} old turns`);

// ─── Startup: process any unextracted turns from previous sessions ───────────
extractor.processBacklog().catch(e =>
  console.warn('[anamnesis] backlog processing error:', e.message)
);
foresightExtractor.processBacklog().catch(e =>
  console.warn('[anamnesis] foresight backlog error:', e.message)
);

// Start background consolidation
consolidator.start(config.memory.consolidationIntervalMs);

// ─── Session key ─────────────────────────────────────────────────────────────
function getSessionKey(req) {
  const ocSession = req.headers['x-openclaw-session'] ?? req.headers['x-session-id'] ?? '';
  if (ocSession) return `oc:${ocSession}`;
  const auth = req.headers['authorization'] ?? '';
  // Strip "Bearer " prefix and use last 16 chars as key
  const token = auth.replace(/^Bearer\s+/i, '');
  if (token && token !== config.upstream.apiKey) return `auth:${token.slice(-16)}`;
  return 'default';
}

// ─── Universal upstream forwarding ───────────────────────────────────────────
function forward(reqOpts, body) {
  return new Promise((resolve, reject) => {
    const upUrl   = new URL(config.upstream.baseUrl);
    const isHttps = upUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;

    // Build headers — inject upstream API key, strip proxy-internal headers
    const headers = { ...reqOpts.headers };
    delete headers['x-openclaw-session'];
    delete headers['x-session-id'];
    delete headers['host'];
    // Remove all case variants of Content-Length before setting the correct one
    Object.keys(headers).forEach(k => { if (k.toLowerCase() === 'content-length') delete headers[k]; });
    headers['Authorization']  = config.upstream.apiKey ? `Bearer ${config.upstream.apiKey}` : undefined;
    headers['Content-Length'] = Buffer.byteLength(body);
    // Remove undefined headers
    Object.keys(headers).forEach(k => headers[k] === undefined && delete headers[k]);

    const opts = {
      hostname: upUrl.hostname,
      port:     upUrl.port || (isHttps ? 443 : 80),
      path:     upUrl.pathname.replace(/\/$/, '') + (reqOpts.url ?? reqOpts.path),
      method:   reqOpts.method,
      headers,
    };

    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks)
      }));
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Status endpoint
  if (req.method === 'GET' && req.url === '/anamnesis/status') {
    const stats = history.stats('default');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ok', ...stats, upstream: config.upstream.baseUrl }));
  }

  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
      let parsed;
      try { parsed = JSON.parse(rawBody.toString()); }
      catch { return passthrough(req, res, rawBody); }
      if (!Array.isArray(parsed.messages)) return passthrough(req, res, rawBody);

      const sessionKey = getSessionKey(req);
      const streaming  = parsed.stream === true;

      // 1. Store user turn immediately (synchronous — survives shutdown)
      const userMsg = [...parsed.messages].reverse().find(m => m.role === 'user');
      if (userMsg?.content) {
        // Embed async — if it fails, store without embedding
        const vec = await embedder.embed(userMsg.content).catch(() => null);
        const est = Math.ceil(userMsg.content.length / config.context.charsPerToken);
        history.insertTurn(sessionKey, 'user', userMsg.content, vec, est);
      }

      // 2. Scene-guided context selection
      let selectedMessages = parsed.messages;
      try {
        selectedMessages = await selector.select(sessionKey, parsed.messages);
      } catch (err) {
        console.error('[anamnesis] selector error, using original:', err.message);
      }

      // 3. Forward to upstream — optionally disable thinking mode (Qwen3 etc.)
      const rewritten = { ...parsed, messages: selectedMessages };
      if (config.upstream.disableThinking) {
        rewritten.chat_template_kwargs = { ...rewritten.chat_template_kwargs, enable_thinking: false };
      }
      const rewrittenBody = Buffer.from(JSON.stringify(rewritten));
      let upRes;
      try {
        upRes = await forward(req, rewrittenBody);
      } catch (err) {
        console.error('[anamnesis] upstream error:', err.message);
        res.writeHead(502);
        return res.end(JSON.stringify({ error: err.message }));
      }

      // 4. Return response to client first
      res.writeHead(upRes.status, upRes.headers);
      res.end(upRes.body);

      // 5. Store assistant turn + background extraction (non-blocking, after response sent)
      if (!streaming) {
        setImmediate(async () => {
          try {
            const upParsed = JSON.parse(upRes.body.toString());
            const content  = upParsed.choices?.[0]?.message?.content ?? '';
            if (content) {
              const vec = await embedder.embed(content.slice(0, 2000)).catch(() => null);
              const est = Math.ceil(content.length / config.context.charsPerToken);
              history.insertTurn(sessionKey, 'assistant', content, vec, est);
              // Trigger background extraction (memcells + foresights) — non-blocking
              extractor.processBatch().catch(e =>
                console.warn('[anamnesis] extractor:', e.message)
              );
              foresightExtractor.processBatch().catch(e =>
                console.warn('[anamnesis] foresight:', e.message)
              );
            }
          } catch { /* non-fatal */ }
        });
      }
      return;
    }

    passthrough(req, res, rawBody);
  });
});

async function passthrough(req, res, body) {
  try {
    const upRes = await forward(req, body);
    res.writeHead(upRes.status, upRes.headers);
    res.end(upRes.body);
  } catch (err) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: err.message }));
  }
}

server.listen(config.proxy.port, config.proxy.host, () => {
  console.log(`[anamnesis] listening on ${config.proxy.host}:${config.proxy.port}`);
  console.log(`[anamnesis] upstream: ${config.upstream.baseUrl}`);
  console.log(`[anamnesis] extraction model: ${config.extraction.model}`);
  console.log(`[anamnesis] token budget: ${config.context.tokenBudget} | recency: ${config.context.recencyTurns} turns | slots: ${config.context.rotatingSlots}`);
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`[anamnesis] received ${signal}, shutting down gracefully...`);
  consolidator.stop();
  server.close();
  await Promise.all([
    extractor.flushInFlight(),
    foresightExtractor.flushInFlight(),
  ]);
  console.log('[anamnesis] shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
