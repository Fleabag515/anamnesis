'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  groupUnits,
  taskHeadIndex,
  planEviction,
  compactUnit,
  unitText,
} = require('../../src/lib/exchanges.js');

const call = (id, name) => ({ id, type: 'function', function: { name, arguments: '{}' } });

function agenticConvo() {
  return [
    { role: 'user', content: 'refactor the vault module' },
    { role: 'assistant', tool_calls: [call('c1', 'read_file')], content: null },
    { role: 'tool', tool_call_id: 'c1', content: 'file contents '.repeat(50) },
    { role: 'assistant', content: 'I see the issue.' },
    { role: 'assistant', tool_calls: [call('c2', 'run_tests'), call('c3', 'lint')], content: null },
    { role: 'tool', tool_call_id: 'c2', content: 'tests pass' },
    { role: 'tool', tool_call_id: 'c3', content: 'lint clean' },
    { role: 'user', content: 'now add a test' },
  ];
}

test('groupUnits keeps tool_calls + results atomic', () => {
  const units = groupUnits(agenticConvo());
  assert.equal(units.length, 5); // user, exchange, plain assistant, exchange(2 results), user
  assert.equal(units[1].kind, 'exchange');
  assert.equal(units[1].msgs.length, 2);
  assert.equal(units[3].kind, 'exchange');
  assert.equal(units[3].msgs.length, 3); // assistant + two tool results
});

test('orphan tool message folds into previous exchange or stands alone', () => {
  const units = groupUnits([
    { role: 'tool', tool_call_id: 'zz', content: 'orphan result' },
    { role: 'user', content: 'hi' },
  ]);
  assert.equal(units[0].kind, 'plain');
  assert.equal(units[0].orphan, true);
});

test('taskHeadIndex finds the first user message', () => {
  const units = groupUnits(agenticConvo());
  assert.equal(taskHeadIndex(units), 0);
});

test('planEviction keeps pinned + newest-within-budget, evicts oldest first', () => {
  const units = groupUnits(agenticConvo());
  const costs = units.map(() => 100);
  const pinned = new Set([0, units.length - 1]);
  // room for exactly one middle unit
  const { keep, evict } = planEviction(units, costs, pinned, 150);
  assert.ok(keep.has(0) && keep.has(units.length - 1));
  assert.ok(keep.has(units.length - 2)); // newest middle unit survives
  assert.deepEqual(evict, [1, 2]); // oldest evicted, ascending
});

test('planEviction with zero budget evicts all unpinned', () => {
  const units = groupUnits(agenticConvo());
  const costs = units.map(() => 10);
  const { keep, evict } = planEviction(units, costs, new Set([0]), 0);
  assert.deepEqual([...keep], [0]);
  assert.equal(evict.length, units.length - 1);
});

test('compactUnit produces a single assistant message naming the tools', () => {
  const units = groupUnits(agenticConvo());
  const msg = compactUnit(units[3]);
  assert.equal(msg.role, 'assistant');
  assert.match(msg.content, /run_tests, lint/);
  assert.match(msg.content, /tests pass/);
});

test('compactUnit prefers artifact notes for spilled results', () => {
  const units = groupUnits(agenticConvo());
  const notes = new Map([['c1', '[artifact ab12 · read_file result · ~700 tok · evicted] …']]);
  const msg = compactUnit(units[1], notes);
  assert.match(msg.content, /artifact ab12/);
});

test('unitText covers content and tool_calls JSON', () => {
  const units = groupUnits(agenticConvo());
  assert.match(unitText(units[1]), /read_file/);
  assert.match(unitText(units[1]), /file contents/);
});
