#!/usr/bin/env node
/**
 * proxy.js — Anamnesis main server
 *
 * Pipeline per request:
 *   1. Intercept /v1/chat/completions
 *   2. Store incoming user turn + embed
 *   3. Run scene-guided context selection
 *   4. Forward rewritten request to llama-server
 *   5. Store assistant response + embed (async)
 *   6. Trigger background MemCell extraction (async, non-blocking)
 */

const http    = require('http');
const https   = require('https');
const path    = require('path');
const fs      = require('fs');

const config      = JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8'));
const HistoryStore = require('./history.js');
const Embedder    = require('./embedder.js');
const Selector    = require('./selector.js');
const Extractor   = require('./extractor.js');
const Consolidator = require('./consolidator.js');

const history     = new HistoryStore(config.history.dbPath);
const embedder    = new Embedder(config.embedding.ollamaUrl, config.embedding.model);
const selector    = new Selector(config, history, embedder);
const extractor   = new Extractor(config.embedding.ollamaUrl, config.extraction.model, history, embedder);
const consolidator = new Consolidator(config, history, embedder);

// Prune old turns on startup
const pruned = history.prune(config.history.maxAgeDays);
if (pruned > 0) console.log(`[anamnesis] pruned ${pruned} old turns`);

// Start background consolidation
consolidator.start(config.memory.consolidationIntervalMs);

// ─── Session key ─────────────────────────────────────────────────────────────
function getSessionKey(req) {
  const ocSession = req.headers['x-openclaw-session'] ?? req.headers['x-session-id'] ?? '';
  if (ocSession) return `oc:${ocSession}`;
  const auth = req.headers['authorization'] ?? '';
  if (auth) return `auth:${auth.slice(-16)}`;
  return 'default';
}

// ─── Upstream forwarding ─────────────────────────────────────────────────────
function forward(reqOpts, body) {
  return new Promise((resolve, reject) => {
    const upUrl   = new URL(config.upstream.baseUrl);
    const isHttps = upUrl.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const opts    = {
      hostname: upUrl.hostname,
      port:     upUrl.port || (isHttps ? 443 : 80),
      path:     reqOpts.path,
      method:   reqOpts.method,
      headers:  {
        ...reqOpts.headers,
        'Authorization':  `Bearer ${config.upstream.apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(); reject(new Error('upstream timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const chunks = [];
  req.on('data', d => chunks.push(d));
  req.on('end', async () => {
    const rawBody = Buffer.concat(chunks);

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let parsed;
      try { parsed = JSON.parse(rawBody.toString()); }
      catch { return passthrough(req, res, rawBody); }
      if (!Array.isArray(parsed.messages)) return passthrough(req, res, rawBody);

      const sessionKey = getSessionKey(req);
      const streaming  = parsed.stream === true;

      // Store + embed incoming user turn
      const userMsg = [...parsed.messages].reverse().find(m => m.role === 'user');
      if (userMsg?.content) {
        const vec = await embedder.embed(userMsg.content).catch(() => null);
        const est = Math.ceil(userMsg.content.length / config.context.charsPerToken);
        history.insertTurn(sessionKey, 'user', userMsg.content, vec, est);
      }

      // Scene-guided context selection
      let selectedMessages = parsed.messages;
      try {
        selectedMessages = await selector.select(sessionKey, parsed.messages);
      } catch (err) {
        console.error('[anamnesis] selector error, using original:', err.message);
      }

      // Forward to llama-server
      const rewritten     = { ...parsed, messages: selectedMessages };
      const rewrittenBody = Buffer.from(JSON.stringify(rewritten));
      let upRes;
      try {
        upRes = await forward(req, rewrittenBody);
      } catch (err) {
        res.writeHead(502);
        return res.end(JSON.stringify({ error: err.message }));
      }

      // Store assistant response + trigger background extraction (non-blocking)
      if (!streaming) {
        setImmediate(async () => {
          try {
            const upParsed = JSON.parse(upRes.body.toString());
            const content  = upParsed.choices?.[0]?.message?.content ?? '';
            if (content) {
              const vec = await embedder.embed(content.slice(0, 2000)).catch(() => null);
              const est = Math.ceil(content.length / config.context.charsPerToken);
              history.insertTurn(sessionKey, 'assistant', content, vec, est);
              // Background: extract MemCells from this turn
              extractor.processBatch().catch(e =>
                console.warn('[anamnesis] extractor error:', e.message)
              );
            }
          } catch { /* non-fatal */ }
        });
      }

      res.writeHead(upRes.status, upRes.headers);
      return res.end(upRes.body);
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

// ─── Status endpoint ─────────────────────────────────────────────────────────
// Override /anamnesis/status for monitoring
const _origCreateServer = server;
server.on('request', (req, res) => {
  if (req.url === '/anamnesis/status') {
    const stats = history.stats('default');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ...stats }));
  }
});

server.listen(config.proxy.port, config.proxy.host, () => {
  console.log(`[anamnesis] listening on ${config.proxy.host}:${config.proxy.port}`);
  console.log(`[anamnesis] upstream: ${config.upstream.baseUrl}`);
  console.log(`[anamnesis] embedding: ${config.embedding.model}`);
  console.log(`[anamnesis] extraction: ${config.extraction.model}`);
  console.log(`[anamnesis] budget: ${config.context.tokenBudget} tokens | recency: ${config.context.recencyTurns} turns | slots: ${config.context.rotatingSlots}`);
});

process.on('SIGTERM', () => { consolidator.stop(); server.close(); process.exit(0); });
process.on('SIGINT',  () => { consolidator.stop(); server.close(); process.exit(0); });
