'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  RECALL_TOOL_NAME,
  withRecallTool,
  collectToolCalls,
  classifyResponse,
  makeToolCallAccumulator,
  recallExchangeMessages,
} = require('../../src/lib/recall-tool.js');

test('withRecallTool appends once, idempotently, without mutating input', () => {
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const out = withRecallTool(tools);
  assert.equal(out.length, 2);
  assert.equal(tools.length, 1); // no mutation
  assert.equal(withRecallTool(out).length, 2); // idempotent
  assert.equal(out[1].function.name, RECALL_TOOL_NAME);
});

test('classifyResponse distinguishes recall-only / mixed / tools / content', () => {
  const rc = (name, id) => ({ id, type: 'function', function: { name, arguments: '{}' } });
  assert.equal(classifyResponse({ content: 'hi' }), 'content');
  assert.equal(classifyResponse({ tool_calls: [rc('recall', 'a')] }), 'recall-only');
  assert.equal(classifyResponse({ tool_calls: [rc('recall', 'a'), rc('grep', 'b')] }), 'mixed');
  assert.equal(classifyResponse({ tool_calls: [rc('grep', 'b')] }), 'tools');
  assert.equal(classifyResponse({}), 'none');
});

test('collectToolCalls tolerates malformed arguments', () => {
  const calls = collectToolCalls({
    tool_calls: [{ id: 'x', function: { name: 'recall', arguments: '{oops' } }],
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, {});
});

test('accumulator reconstructs streamed tool calls split across frames', () => {
  const acc = makeToolCallAccumulator();
  const frames = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'recall', arguments: '' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"id":"a' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'b12"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  // feed split mid-frame to exercise buffering
  const raw = frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n';
  const mid = Math.floor(raw.length / 2) + 3;
  acc.feed(Buffer.from(raw.slice(0, mid)));
  acc.feed(Buffer.from(raw.slice(mid)));

  const msg = acc.message();
  assert.equal(acc.finishReason, 'tool_calls');
  assert.equal(msg.tool_calls.length, 1);
  assert.equal(msg.tool_calls[0].function.name, 'recall');
  assert.deepEqual(JSON.parse(msg.tool_calls[0].function.arguments), { id: 'ab12' });
});

test('accumulator reconstructs streamed content', () => {
  const acc = makeToolCallAccumulator();
  for (const piece of ['Hel', 'lo ', 'world']) {
    acc.feed(Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
  }
  assert.equal(acc.message().content, 'Hello world');
  assert.equal(acc.sawToolCall, false);
});

test('recallExchangeMessages pairs results to the assistant message', () => {
  const assistant = {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'c9', type: 'function', function: { name: 'recall', arguments: '{}' } }],
  };
  const msgs = recallExchangeMessages(assistant, [{ id: 'c9', text: 'archived text' }]);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].role, 'tool');
  assert.equal(msgs[1].tool_call_id, 'c9');
});
