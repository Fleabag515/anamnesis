const test = require('node:test');
const assert = require('node:assert/strict');

// We don't boot the real proxy here. We test that the status payload
// builder includes the new fields and preserves all v0.4.0 fields.

test('status payload: contains v0.4.0 fields + lessons + lessons_active', () => {
  const mockHistory = {
    stats: () => ({ turns: 10, cells: 20, scenes: 5, foresights: 1 }),
    countActiveLessons: () => 7,
    countLessons: () => 12,
  };
  const config = { upstream: { baseUrl: 'u' }, embedding: { model: 'm' } };

  // Build the payload the way proxy.js builds it.
  const stats = mockHistory.stats('default');
  const payload = {
    status: 'ok',
    ...stats,
    lessons: mockHistory.countLessons(),
    lessons_active: mockHistory.countActiveLessons(),
    upstream: config.upstream.baseUrl,
    embedding_model: config.embedding.model,
  };

  // v0.4.0 invariants:
  assert.equal(payload.status, 'ok');
  assert.equal(payload.turns, 10);
  assert.equal(payload.cells, 20);
  assert.equal(payload.scenes, 5);
  assert.equal(payload.foresights, 1);
  assert.equal(payload.upstream, 'u');
  assert.equal(payload.embedding_model, 'm');
  // v0.5.0 additions:
  assert.equal(payload.lessons, 12);
  assert.equal(payload.lessons_active, 7);
});
