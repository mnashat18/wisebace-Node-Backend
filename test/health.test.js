import test from 'node:test';
import assert from 'node:assert/strict';

test('Node runtime supports the backend test harness', () => {
  assert.equal(typeof fetch, 'function');
  assert.match(process.version, /^v\d+\./);
});
