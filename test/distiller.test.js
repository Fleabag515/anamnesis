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
