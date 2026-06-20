'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

const Selector = require('../src/selector.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMockHistory() {
  return {
    getScenes: () => [],
    getActiveForesights: () => [],
    getSessionTurns: () => [],
    stats: () => ({ turns: 0, cells: 0, scenes: 0, foresights: 0 }),
    bumpTurnRecall: () => {},
    bumpSceneRecall: () => {},
  };
}

function makeMockEmbedder() {
  return {
    model: 'test-model',
    embed: async () => new Float32Array([0.1, 0.2]),
  };
}

function makeConfig() {
  return {
    context: {
      tokenBudget: 50000,
      systemReserveTokens: 500,
      recencyTurns: 8, // recencyWindow = 16 messages
      rotatingSlots: 6,
      charsPerToken: 4,
      minChunkChars: 40,
    },
  };
}

// Simulate Pleiades's engine.py tool-calling loop for a SINGLE user turn:
// one user message, then many (assistant tool_call, tool result) round-trips,
// all within the one ever-growing `messages` array for that one turn (this is
// exactly what _loop()/stream_events() in pleiades/engine.py send on every
// round -- the full array, original user message included).
function buildLongToolLoopTurn(rounds) {
  const messages = [
    { role: 'system', content: 'You are Mark.' },
    { role: 'user', content: 'go log into instagram for me' },
  ];
  for (let i = 0; i < rounds; i++) {
    messages.push({ role: 'assistant', content: `calling tool round ${i}` });
    messages.push({ role: 'tool', content: `tool result ${i}` });
  }
  messages.push({ role: 'assistant', content: 'final reply' });
  return messages;
}

test('select() must not drop the turn-anchoring user message when the incoming tool-call loop exceeds the recency window', async () => {
  const selector = new Selector(makeConfig(), makeMockHistory(), makeMockEmbedder(), null);

  // recencyWindow = recencyTurns(8) * 2 = 16 non-system messages.
  // 9 tool rounds -> 1 user + 18 assistant/tool messages = 19 convo messages,
  // well past the 16-message window.
  const incoming = buildLongToolLoopTurn(9);
  const result = await selector.select('session-1', incoming);

  const hasUser = result.some((m) => m.role === 'user');
  assert.ok(
    hasUser,
    'selected context sent upstream has NO user-role message at all -- ' +
      'this is exactly what makes the Qwen3 chat template raise ' +
      `"No user query found in messages." Got roles: ${result.map((m) => m.role).join(',')}`
  );
});

test('select() still includes the user message for a normal short turn (no regression)', async () => {
  const selector = new Selector(makeConfig(), makeMockHistory(), makeMockEmbedder(), null);
  const incoming = buildLongToolLoopTurn(1); // well under the window
  const result = await selector.select('session-1', incoming);
  assert.ok(result.some((m) => m.role === 'user'));
});
