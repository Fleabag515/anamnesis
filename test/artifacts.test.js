'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HistoryStore = require('../src/history.js');
const ArtifactStore = require('../src/artifacts.js');

class FakeEmbedder {
  get model() {
    return 'fake-embed';
  }
  async embed(text) {
    // word-hash bag embedding: shared words → high cosine, disjoint → ~0
    const v = new Float32Array(64);
    for (const w of String(text).toLowerCase().split(/[^a-z0-9_]+/)) {
      if (!w) continue;
      let h = 0;
      for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % 64] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  static cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }
}

function fresh() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-art-'));
  const history = new HistoryStore(path.join(dir, 'history.db'));
  const store = new ArtifactStore({ artifacts: { spillTokens: 100 } }, history, new FakeEmbedder());
  return { history, store };
}

async function settle(ms = 60) {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, ms));
}

test('spill stores full content, dedupes by hash, returns a handle', async () => {
  const { history, store } = fresh();
  const content = 'line one\n'.repeat(300);
  const a = store.spill('s1', { toolName: 'read_file', content, tokenEst: 700 });
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.match(a.handle, /artifact/);
  assert.match(a.handle, /read_file/);
  assert.match(a.handle, /recall\(/);

  const b = store.spill('s1', { toolName: 'read_file', content, tokenEst: 700 });
  assert.equal(b.id, a.id); // dedupe

  const row = history.getArtifact(a.id);
  assert.equal(row.content, content);
  await settle();
  history.close();
});

test('recall by id slices and paginates', async () => {
  const { history, store } = fresh();
  const content = 'A'.repeat(10000);
  const { id } = store.spill('s1', { content, tokenEst: 3000 });
  const first = await store.recall('s1', { id, max_chars: 4000 });
  assert.match(first, /chars 0–4000 of 10000/);
  assert.match(first, /"offset":4000/);
  const second = await store.recall('s1', { id, offset: 4000, max_chars: 8000 });
  assert.match(second, /chars 4000–10000 of 10000/);
  assert.ok(!second.includes('remain'));
  assert.equal(history.getArtifact(id).recall_count, 2);
  history.close();
});

test('recall by query finds chunks semantically (with LIKE fallback)', async () => {
  const { history, store } = fresh();
  store.spill('s1', {
    toolName: 'read_file',
    content: 'def encrypt_vault(key):\n    return fernet.encrypt(key)\n' + 'pad '.repeat(500),
    tokenEst: 600,
  });
  store.spill('s1', { toolName: 'web_search', content: 'weather tomorrow: rain. ' + 'x '.repeat(800), tokenEst: 500 });
  await settle(120); // let background chunk embedding land

  const hit = await store.recall('s1', { query: 'encrypt_vault' });
  assert.match(hit, /artifact/);
  assert.match(hit, /encrypt_vault/);

  // 'zorblax' shares no word-hash bucket with any stored content above
  const miss = await store.recall('s1', { query: 'zorblax' });
  assert.match(miss, /nothing archived/);
  history.close();
});

test('recall with bad args fails soft', async () => {
  const { history, store } = fresh();
  assert.match(await store.recall('s1', {}), /provide/);
  assert.match(await store.recall('s1', { id: 'nope1234' }), /no artifact/);
  history.close();
});

test('history: tool turns carry kind + tool metadata and late embeddings', async () => {
  const { history } = fresh();
  const id = history.insertTurn('s1', 'tool', 'result text', null, 3, null, {
    kind: 'tool_result',
    toolName: 'grep',
    toolCallId: 'c7',
  });
  const turns = history.getSessionTurns('s1');
  assert.equal(turns[0].kind, 'tool_result');
  assert.equal(turns[0].tool_name, 'grep');
  const vec = new Float32Array([1, 2, 3]);
  history.updateTurnEmbedding(id, vec, 'fake-embed');
  const after = history.getSessionTurns('s1')[0];
  assert.equal(after.embedding_model, 'fake-embed');
  assert.equal(HistoryStore.toFloat32(after.embedding).length, 3);
  history.close();
});

test('artifactStats aggregates per session', async () => {
  const { history, store } = fresh();
  store.spill('s1', { content: 'a'.repeat(900), tokenEst: 250 });
  store.spill('s1', { content: 'b'.repeat(900), tokenEst: 250 });
  store.spill('other', { content: 'c'.repeat(900), tokenEst: 250 });
  const st = history.artifactStats('s1');
  assert.equal(st.count, 2);
  assert.equal(st.tokens, 500);
  history.close();
});
