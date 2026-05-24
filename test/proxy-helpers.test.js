const test = require('node:test');
const assert = require('node:assert/strict');

const {
  expandHome,
  extractContentText,
  getSessionKey,
  buildUpstreamHeaders,
  makeSseAccumulator,
} = require('../src/lib/proxy-helpers.js');

// ─── extractContentText ─────────────────────────────────────────────────────

test('extractContentText: passes strings through', () => {
  assert.equal(extractContentText('hello'), 'hello');
});

test('extractContentText: joins OpenAI text parts', () => {
  const parts = [
    { type: 'text', text: 'first' },
    { type: 'text', text: 'second' },
  ];
  assert.equal(extractContentText(parts), 'first\nsecond');
});

test('extractContentText: mixed parts keep only text', () => {
  const parts = [
    { type: 'text', text: 'hello' },
    { type: 'tool_result', tool_use_id: 'x', content: 'ignored' },
    { type: 'text', text: 'world' },
  ];
  assert.equal(extractContentText(parts), 'hello\nworld');
});

test('extractContentText: array with no text parts falls back to JSON', () => {
  const parts = [{ type: 'image_url', image_url: { url: 'data:foo' } }];
  const out = extractContentText(parts);
  // Either JSON of the parts or empty — must be a string, never the array.
  assert.equal(typeof out, 'string');
  assert.ok(out.includes('image_url'));
});

test('extractContentText: object → JSON', () => {
  assert.equal(extractContentText({ a: 1 }), '{"a":1}');
});

test('extractContentText: null/undefined → empty string', () => {
  assert.equal(extractContentText(null), '');
  assert.equal(extractContentText(undefined), '');
});

// ─── expandHome ─────────────────────────────────────────────────────────────

test('expandHome: rewrites ~ to HOME', () => {
  const out = expandHome({ p: '~/foo' }, '/home/fake');
  assert.equal(out.p, '/home/fake/foo');
});

test('expandHome: rewrites ${HOME} and $HOME', () => {
  assert.equal(expandHome('${HOME}/x', '/h'), '/h/x');
  assert.equal(expandHome('$HOME/y', '/h'), '/h/y');
});

test('expandHome: leaves non-leading ~ alone', () => {
  assert.equal(expandHome('a/~/b', '/h'), 'a/~/b');
});

test('expandHome: deeply nested', () => {
  const cfg = { a: { b: ['~/x', { c: '~/y' }] } };
  const out = expandHome(cfg, '/H');
  assert.deepEqual(out, { a: { b: ['/H/x', { c: '/H/y' }] } });
});

test('expandHome: non-string scalars untouched', () => {
  assert.equal(expandHome(42, '/h'), 42);
  assert.equal(expandHome(null, '/h'), null);
  assert.equal(expandHome(true, '/h'), true);
});

// ─── getSessionKey ──────────────────────────────────────────────────────────

test('getSessionKey: explicit X-OpenClaw-Session wins', () => {
  const k = getSessionKey({ 'x-openclaw-session': 'abc123' }, 'apikey');
  assert.equal(k, 'oc:abc123');
});

test('getSessionKey: X-Session-Id fallback', () => {
  const k = getSessionKey({ 'x-session-id': 'sess-xyz' }, 'apikey');
  assert.equal(k, 'oc:sess-xyz');
});

test('getSessionKey: hashes bearer token, prefix only', () => {
  const k = getSessionKey({ authorization: 'Bearer super-secret-12345' }, 'somethingelse');
  assert.match(k, /^auth:[a-f0-9]{16}$/);
  // The raw token must not appear in the derived key.
  assert.ok(!k.includes('super-secret'));
});

test('getSessionKey: ignores upstream apiKey echo', () => {
  // If the client (or a misconfigured tool) sent our own configured upstream
  // apiKey, we shouldn't fingerprint that as a "real" user session.
  const k = getSessionKey({ authorization: 'Bearer localqwen' }, 'localqwen');
  assert.equal(k, 'default');
});

test('getSessionKey: returns default when no auth', () => {
  assert.equal(getSessionKey({}, 'anything'), 'default');
});

test('getSessionKey: same token => same key (deterministic)', () => {
  const a = getSessionKey({ authorization: 'Bearer T' }, '');
  const b = getSessionKey({ authorization: 'Bearer T' }, '');
  assert.equal(a, b);
});

// ─── buildUpstreamHeaders ───────────────────────────────────────────────────

test('buildUpstreamHeaders: strips proxy-internal + hop-by-hop headers', () => {
  const out = buildUpstreamHeaders(
    {
      host: 'localhost:8084',
      'x-openclaw-session': 's',
      'x-session-id': 's2',
      'content-length': '999',
      connection: 'keep-alive',
      'transfer-encoding': 'chunked',
      'x-other': 'keep',
    },
    { upstreamApiKey: 'K' }
  );
  assert.equal(out['host'], undefined);
  assert.equal(out['x-openclaw-session'], undefined);
  assert.equal(out['x-session-id'], undefined);
  assert.equal(out['content-length'], undefined);
  assert.equal(out['connection'], undefined);
  assert.equal(out['transfer-encoding'], undefined);
  assert.equal(out['x-other'], 'keep');
});

test('buildUpstreamHeaders: injects Authorization when apiKey is set', () => {
  const out = buildUpstreamHeaders(
    { authorization: 'Bearer client-token' },
    { upstreamApiKey: 'SERVER-KEY' }
  );
  // Should be overwritten, not duplicated.
  const authKeys = Object.keys(out).filter((k) => k.toLowerCase() === 'authorization');
  assert.equal(authKeys.length, 1);
  assert.equal(out[authKeys[0]], 'Bearer SERVER-KEY');
});

test('buildUpstreamHeaders: passes Authorization through when apiKey empty', () => {
  const out = buildUpstreamHeaders(
    { authorization: 'Bearer client-token' },
    { upstreamApiKey: '' }
  );
  // The client-supplied header must survive untouched.
  const authKey = Object.keys(out).find((k) => k.toLowerCase() === 'authorization');
  assert.equal(out[authKey], 'Bearer client-token');
});

// ─── makeSseAccumulator ─────────────────────────────────────────────────────

function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

test('SSE: reconstructs content from delta frames', () => {
  const acc = makeSseAccumulator();
  acc.feed(Buffer.from(sseFrame({ choices: [{ delta: { content: 'Hello' } }] })));
  acc.feed(Buffer.from(sseFrame({ choices: [{ delta: { content: ', world' } }] })));
  acc.feed(Buffer.from(sseFrame({ choices: [{ delta: { content: '!' } }] })));
  acc.feed(Buffer.from('data: [DONE]\n\n'));
  assert.equal(acc.content, 'Hello, world!');
});

test('SSE: handles frame split across chunk boundaries', () => {
  const acc = makeSseAccumulator();
  const frame = sseFrame({ choices: [{ delta: { content: 'split-frame' } }] });
  const mid = Math.floor(frame.length / 2);
  acc.feed(Buffer.from(frame.slice(0, mid)));
  acc.feed(Buffer.from(frame.slice(mid)));
  assert.equal(acc.content, 'split-frame');
});

test('SSE: ignores keepalives and non-JSON lines', () => {
  const acc = makeSseAccumulator();
  acc.feed(Buffer.from(': ping\n\n'));
  acc.feed(Buffer.from('data: not-json\n\n'));
  acc.feed(Buffer.from(sseFrame({ choices: [{ delta: { content: 'OK' } }] })));
  assert.equal(acc.content, 'OK');
});

test('SSE: also picks up message.content shape', () => {
  const acc = makeSseAccumulator();
  acc.feed(Buffer.from(sseFrame({ choices: [{ message: { content: 'final' } }] })));
  assert.equal(acc.content, 'final');
});

test('SSE: empty stream => empty content', () => {
  const acc = makeSseAccumulator();
  acc.feed(Buffer.from('data: [DONE]\n\n'));
  assert.equal(acc.content, '');
});
