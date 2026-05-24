const test   = require('node:test');
const assert = require('node:assert/strict');

const { tryParseJsonArray, tryParseJsonObject } = require('../src/lib/ollama.js');

test('tryParseJsonArray: plain JSON array', () => {
  assert.deepEqual(tryParseJsonArray('[1,2,3]'), [1, 2, 3]);
});

test('tryParseJsonArray: array embedded in prose', () => {
  const out = tryParseJsonArray('Here you go:\n[{"a":1}]\nThat\'s it.');
  assert.deepEqual(out, [{ a: 1 }]);
});

test('tryParseJsonArray: ignores markdown fences', () => {
  const out = tryParseJsonArray('```json\n[1, 2]\n```');
  assert.deepEqual(out, [1, 2]);
});

test('tryParseJsonArray: returns null on no array', () => {
  assert.equal(tryParseJsonArray('no brackets at all'), null);
});

test('tryParseJsonArray: returns null on malformed array', () => {
  assert.equal(tryParseJsonArray('[1, 2,'), null);
});

test('tryParseJsonArray: empty/null input', () => {
  assert.equal(tryParseJsonArray(''), null);
  assert.equal(tryParseJsonArray(null), null);
});

test('tryParseJsonObject: plain JSON object', () => {
  assert.deepEqual(tryParseJsonObject('{"a":1}'), { a: 1 });
});

test('tryParseJsonObject: object embedded in prose', () => {
  const out = tryParseJsonObject('Sure: {"title":"x","summary":"y"} done.');
  assert.deepEqual(out, { title: 'x', summary: 'y' });
});

test('tryParseJsonObject: returns null on no object', () => {
  assert.equal(tryParseJsonObject('nothing here'), null);
});

test('tryParseJsonObject: returns null on malformed', () => {
  assert.equal(tryParseJsonObject('{ broken'), null);
});
