import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderLabel, orderReference } from '../src/orders.ts';

// Existing assertions stay unchanged for baseline, candidate, and patched runs.
const readJSON = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = async (url) => {
  assert.equal(url, '/orders/current');
  return new Response(JSON.stringify(readJSON('./response.json')), { status: 200 });
}; });
after(() => { globalThis.fetch = originalFetch; });
test('order label preserves the display expectation', async () => {
  assert.equal(await orderLabel(), readJSON('../fixtures/expected-label.json'));
});
test('order reference preserves the unchanged identifier', async () => {
  assert.equal(await orderReference(), readJSON('../fixtures/expected-reference.json'));
});
