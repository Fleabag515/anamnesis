'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HistoryStore = require('../src/history.js');
const ArtifactStore = require('../src/artifacts.js');
const Selector = require('../src/selector.js');

class FakeEmbedder {
  get model() {
    return 'fake-embed';
  }
  async embed(text) {
    const v = new Float32Array(8);
    for (let i = 0; i < text.length; i++) v[i % 8] += text.charCodeAt(i) / 1000;
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  }
  static cosine(a, b) {
    let dot = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i] * b[i];
    return dot;
  }
}

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{"f":"x"}' } });

/** A long agentic turn: many tool steps, several with huge results. */
function longAgenticConvo(steps = 12, bigEvery = 3) {
  const msgs = [{ role: 'user', content: 'Task: audit the repo and fix the vault bug.' }];
  for (let i = 0; i < steps; i++) {
    const id = `c${i}`;
    msgs.push({ role: 'assistant', content: null, tool_calls: [call(id, i % 2 ? 'read_file' : 'grep')] });
    const big = i % bigEvery === 0;
    msgs.push({
      role: 'tool',
      tool_call_id: id,
      content: big
        ? `step-${i} marker-big\n` + `filler line for step ${i} `.repeat(400)
        : `step-${i} small result ok`,
    });
  }
  msgs.push({ role: 'user', content: 'continue with the next step' });
  return msgs;
}

function fresh(ctxOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anamnesis-sel-'));
  const history = new HistoryStore(path.join(dir, 'history.db'));
  const embedder = new FakeEmbedder();
  const config = {
    context: {
      tokenBudget: 2000, // tight on purpose (no governor → legacy budget path)
      charsPerToken: 3.5,
      pinnedExchanges: 2,
      memoryRefreshTurns: 4,
      ...ctxOverrides,
    },
    artifacts: { spillTokens: 300 },
  };
  const artifacts = new ArtifactStore(config, history, embedder);
  const selector = new Selector(config, history, embedder, null, null, artifacts);
  return { history, selector, artifacts };
}

/** Every tool message must be preceded (anywhere earlier) by an assistant
 *  message whose tool_calls contain its tool_call_id. */
function assertNoOrphanToolMessages(messages) {
  const declared = new Set();
  for (const m of messages) {
    for (const c of m.tool_calls ?? []) declared.add(c.id);
    if (m.role === 'tool') {
      assert.ok(
        declared.has(m.tool_call_id),
        `orphan tool message for ${m.tool_call_id} — pairing broke`
      );
    }
  }
}

test('long agentic turn: stays in budget, pairs intact, artifacts spilled', async () => {
  const { history, selector } = fresh();
  const incoming = longAgenticConvo();

  const { messages, assessment } = await selector.select('s1', incoming);

  assertNoOrphanToolMessages(messages);

  // budget respected (rough char proxy, generous slack for compaction lines)
  const chars = messages.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : 0), 0);
  assert.ok(chars / 3.5 < 2300, `working set ~${Math.round(chars / 3.5)} tok exceeds budget`);

  // the task head survived verbatim
  assert.ok(messages.some((m) => m.role === 'user' && /audit the repo/.test(m.content)));
  // the trailing user message survived verbatim
  assert.ok(messages.some((m) => m.role === 'user' && /continue with the next step/.test(m.content)));
  // compaction happened and points at recall
  assert.ok(messages.some((m) => /compacted/.test(m.content ?? '')));
  // big results actually landed in the artifact store
  assert.ok(history.artifactStats('s1').count >= 2);
  // levels come back even without a governor
  assert.ok(['ok', 'compact', 'aggressive', 'emergency'].includes(assessment.level));
  history.close();
});

test('artifact handles in compacted lines reference recallable ids', async () => {
  const { history, selector, artifacts } = fresh();
  const { messages } = await selector.select('s1', longAgenticConvo());
  const handleIds = [...messages.map((m) => m.content ?? '').join('\n').matchAll(/artifact ([0-9a-f]{8})/g)]
    .map((m) => m[1]);
  assert.ok(handleIds.length >= 1, 'expected at least one artifact handle in the prompt');
  const text = await artifacts.recall('s1', { id: handleIds[0] });
  assert.match(text, /marker-big|filler line/);
  history.close();
});

test('small conversations pass through verbatim (no compaction, no spill)', async () => {
  const { history, selector } = fresh({ tokenBudget: 8000 });
  const incoming = [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi there' },
    { role: 'user', content: 'how are you?' },
  ];
  const { messages, assessment } = await selector.select('s1', incoming);
  assert.ok(messages.some((m) => m.role === 'system' && /helpful/.test(m.content)));
  assert.ok(!messages.some((m) => /compacted/.test(m.content ?? '')));
  assert.equal(history.artifactStats('s1').count, 0);
  assert.equal(assessment.level, 'ok');
  // chronology preserved
  const userIdx = messages.findIndex((m) => m.content === 'hello');
  const lastIdx = messages.findIndex((m) => m.content === 'how are you?');
  assert.ok(userIdx < lastIdx);
  history.close();
});

test('emergency path: pinned set alone over budget still yields valid prompt', async () => {
  const { history, selector } = fresh({ tokenBudget: 300 });
  const incoming = longAgenticConvo(6, 1); // every result big, budget tiny
  const { messages, assessment } = await selector.select('s1', incoming);
  assert.equal(assessment.level, 'emergency');
  assertNoOrphanToolMessages(messages);
  // last unit always survives
  assert.ok(messages.some((m) => m.role === 'user' && /continue/.test(m.content)));
  history.close();
});
