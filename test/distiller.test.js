const test = require('node:test');
const assert = require('node:assert/strict');

const Distiller = require('../src/distiller.js');

function mkDistiller(overrides = {}) {
  const cfg = {
    cognitive: {
      lessons: {
        enabled: true,
        distillationIntervalMs: 60_000,
        minScenesPerLesson: 3,
        lessonClusterThreshold: 0.78,
        model: 'qwen3:0.6b',
      },
    },
    embedding: { ollamaUrl: 'http://127.0.0.1:11434' },
    ...overrides.cfg,
  };
  const history = overrides.history ?? { db: {} };
  const embedder = overrides.embedder ?? { embed: async () => null, model: 'm' };
  return new Distiller(cfg, history, embedder);
}

test('Distiller: start/stop is idempotent', () => {
  const d = mkDistiller();
  d.start(1000);
  d.start(1000); // second start should not double-schedule
  d.stop();
  d.stop(); // second stop should be a no-op
  assert.ok(true);
});

test('Distiller: runs are single-flight', async () => {
  const d = mkDistiller();
  let inFlight = 0;
  let maxInFlight = 0;
  d._runOnce = async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
  };
  // Fire two run() calls back-to-back. The public run() wraps _runOnce
  // with the same _running guard that _scheduleNext uses.
  await Promise.all([d.run(), d.run()]);
  assert.equal(maxInFlight, 1, 'distiller.run must be single-flight');
});

test('Distiller.distillCluster: parses LLM JSON and inserts lesson', async () => {
  const inserts = [];
  const history = {
    db: {},
    insertLesson: (args) => {
      inserts.push(args);
      return 99;
    },
  };
  const embedder = {
    embed: async (s) => new Float32Array([s.length, 0, 0]),
    model: 'nomic-embed-cpu:latest',
  };
  const d = mkDistiller({ history, embedder });
  d._callLLM = async () =>
    '{"content":"User prefers concise reviews.","confidence":0.85,"category":"preference"}';

  await d.distillCluster(
    's1',
    [
      { id: 1, content: 'said no to long reviews' },
      { id: 2, content: 'short PR description' },
      { id: 3, content: 'asked for one-liner' },
    ],
    [10, 11, 12]
  );

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].sessionKey, 's1');
  assert.equal(inserts[0].content, 'User prefers concise reviews.');
  assert.equal(inserts[0].category, 'preference');
  assert.equal(inserts[0].confidence, 0.85);
  assert.deepEqual(inserts[0].supportingSceneIds, [1, 2, 3]);
  assert.deepEqual(inserts[0].supportingMemcellIds, [10, 11, 12]);
  assert.equal(inserts[0].embeddingModel, 'nomic-embed-cpu:latest');
  assert.ok(inserts[0].embedding instanceof Float32Array);
});

test('Distiller.distillCluster: NONE response → no insert', async () => {
  const inserts = [];
  const history = {
    db: {},
    insertLesson: (args) => {
      inserts.push(args);
      return 1;
    },
  };
  const embedder = { embed: async () => new Float32Array([1, 0]), model: 'm' };
  const d = mkDistiller({ history, embedder });
  d._callLLM = async () => 'NONE';
  await d.distillCluster(
    's1',
    [
      { id: 1, content: 'a' },
      { id: 2, content: 'b' },
    ],
    [10]
  );
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: malformed response → no insert', async () => {
  const inserts = [];
  const history = {
    db: {},
    insertLesson: (args) => {
      inserts.push(args);
      return 1;
    },
  };
  const embedder = { embed: async () => null, model: 'm' };
  const d = mkDistiller({ history, embedder });
  d._callLLM = async () => 'I think the rule is concise.';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: confidence below 0.5 → no insert', async () => {
  const inserts = [];
  const history = {
    db: {},
    insertLesson: (args) => {
      inserts.push(args);
      return 1;
    },
  };
  const embedder = { embed: async () => new Float32Array([1]), model: 'm' };
  const d = mkDistiller({ history, embedder });
  d._callLLM = async () => '{"content":"weak rule","confidence":0.3,"category":"other"}';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 0);
});

test('Distiller.distillCluster: invalid category → coerces to "other"', async () => {
  const inserts = [];
  const history = {
    db: {},
    insertLesson: (args) => {
      inserts.push(args);
      return 1;
    },
  };
  const embedder = { embed: async () => new Float32Array([1]), model: 'm' };
  const d = mkDistiller({ history, embedder });
  d._callLLM = async () =>
    '{"content":"a real rule that holds","confidence":0.8,"category":"bogus"}';
  await d.distillCluster('s1', [{ id: 1, content: 'a' }], [10]);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].category, 'other');
});
