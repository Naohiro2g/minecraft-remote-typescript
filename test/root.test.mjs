import assert from 'node:assert/strict';
import test from 'node:test';

test('root module を ESM として読み込める', async () => {
  const root = await import('@mc-remote/client');

  assert.equal(root[Symbol.toStringTag], 'Module');
});
