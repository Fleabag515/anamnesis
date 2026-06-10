'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const ContextGovernor = require('../src/governor.js');

/** Minimal llama-server-shaped upstream: /props + /tokenize (+ optional /resize). */
function stubUpstream({ nCtx = 16384, resizable = false } = {}) {
  const state = { nCtx, resizeCalls: [] };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method === 'GET' && req.url === '/props') {
      return send(200, {
        n_ctx: state.nCtx,
        default_generation_settings: { n_ctx: state.nCtx },
        resizable,
      });
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/tokenize') {
        const { content = '' } = JSON.parse(body || '{}');
        // fake tokenizer: 1 token per 4 chars, at least 1
        return send(200, { tokens: Array(Math.max(1, Math.ceil(content.length / 4))).fill(0) });
      }
      if (req.method === 'POST' && req.url === '/resize') {
        if (!resizable) return send(404, { error: 'no resize' });
        state.nCtx = JSON.parse(body).n_ctx;
        state.resizeCalls.push(state.nCtx);
        return send(200, { n_ctx: state.nCtx });
      }
      send(404, { error: 'nope' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, state, baseUrl: `http://127.0.0.1:${port}/v1` });
    });
  });
}

function cfg(baseUrl, extra = {}) {
  return {
    upstream: { baseUrl },
    context: { charsPerToken: 3.5, completionReserve: 1000, ...extra.context },
    elastic: { enabled: true, pressureCooldownMs: 50, ...extra.elastic },
  };
}

test('discovers n_ctx and tokenizer from /props + /tokenize', async () => {
  const { server, baseUrl } = await stubUpstream({ nCtx: 12345 });
  const gov = new ContextGovernor(cfg(baseUrl));
  await gov.discover();
  assert.equal(gov.nCtx, 12345);
  assert.equal(gov.discovered, true);
  assert.equal(gov.tokenizer, 'llama-server');
  assert.equal(gov.budget(), 12345 - 1000);
  server.close();
});

test('counts via upstream tokenizer with caching', async () => {
  const { server, baseUrl } = await stubUpstream();
  const gov = new ContextGovernor(cfg(baseUrl));
  await gov.discover();
  const text = 'x'.repeat(400);
  assert.equal(await gov.count(text), 100); // 400/4 from stub
  assert.equal(await gov.count(text), 100); // cache hit (same value)
  assert.ok(gov._cache.size >= 1);
  server.close();
});

test('falls back to char estimate when upstream is down', async () => {
  const gov = new ContextGovernor(cfg('http://127.0.0.1:1/v1'));
  await gov.discover(); // probe fails silently
  assert.equal(gov.discovered, false);
  assert.equal(gov.nCtx, 8192); // hint default
  const n = await gov.count('x'.repeat(35));
  assert.equal(n, 10); // 35 / 3.5
});

test('legacy tokenBudget is honoured as the discovery hint', () => {
  const gov = new ContextGovernor({
    upstream: { baseUrl: 'http://127.0.0.1:1' },
    context: { tokenBudget: 50000 },
  });
  assert.equal(gov.nCtx, 50000);
});

test('watermark assessment levels', () => {
  const gov = new ContextGovernor(cfg('http://127.0.0.1:1'));
  gov.nCtx = 1000;
  assert.equal(gov.assess(500).level, 'ok');
  assert.equal(gov.assess(700).level, 'compact');
  assert.equal(gov.assess(850).level, 'aggressive');
  assert.equal(gov.assess(960).level, 'emergency');
  assert.ok(ContextGovernor.levelAtLeast('aggressive', 'compact'));
  assert.ok(!ContextGovernor.levelAtLeast('ok', 'compact'));
});

test('observePromptUsage self-tunes the char ratio toward ground truth', () => {
  const gov = new ContextGovernor(cfg('http://127.0.0.1:1'));
  const before = gov.charsPerToken;
  gov.observePromptUsage(1000, 2000); // we underestimated → ratio must shrink
  assert.ok(gov.charsPerToken < before);
  gov.observePromptUsage(2000, 1000); // overestimated → ratio grows
  assert.ok(gov.charsPerToken > 2);
  for (let i = 0; i < 50; i++) gov.observePromptUsage(1, 100000);
  assert.ok(gov.charsPerToken >= 2); // clamped
});

test('signalPressure asks an elastic upstream to double n_ctx (with cooldown)', async () => {
  const { server, state, baseUrl } = await stubUpstream({ nCtx: 4096, resizable: true });
  const gov = new ContextGovernor(cfg(baseUrl));
  await gov.discover();
  assert.equal(gov.resizable, true);
  gov.signalPressure();
  gov.signalPressure(); // inside cooldown — ignored
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(state.resizeCalls, [8192]);
  assert.equal(gov.nCtx, 8192); // re-discovered after resize
  server.close();
});

test('non-resizable upstream: pressure is a permanent no-op after 404', async () => {
  const { server, state, baseUrl } = await stubUpstream({ nCtx: 4096, resizable: false });
  const gov = new ContextGovernor(cfg(baseUrl));
  await gov.discover();
  assert.equal(gov.resizable, false); // /props said so
  gov.signalPressure();
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(state.resizeCalls, []);
  server.close();
});
