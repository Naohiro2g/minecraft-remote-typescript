import assert from 'node:assert/strict';
import test from 'node:test';

import pkg from '../package.json' with { type: 'json' };
import lock from '../package-lock.json' with { type: 'json' };

test('packageとlockfileの版は2400.0.0', () => {
  assert.equal(pkg.version, '2400.0.0');
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
});

test('root module を ESM として読み込める', async () => {
  const root = await import('@mc-remote/client');

  assert.equal(root[Symbol.toStringTag], 'Module');
});
