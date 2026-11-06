const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseBadge } = require('../badge');

test('读出数字角标', () => {
  assert.equal(parseBadge('"StatusLabel"={ "label"="7" }\n'), 7);
});

test('没有未读时为 0', () => {
  assert.equal(parseBadge('"StatusLabel"=[ NULL ]\n'), 0);
  assert.equal(parseBadge('"StatusLabel"={ "label"="" }\n'), 0);
  assert.equal(parseBadge(''), 0);
});

test('只有红点没有数字时算 1 条', () => {
  assert.equal(parseBadge('"StatusLabel"={ "label"="•" }\n'), 1);
});
