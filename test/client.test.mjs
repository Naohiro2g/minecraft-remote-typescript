// F1の外で、このclientの振る舞いを確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_VERSION,
  PairingExpiredError,
  ProtocolMismatchError,
  RemoteError,
  connect,
  isCompatibleProtocol,
  memoryCredentialStore,
} from '@mc-remote/client';

import { FakeClock, startPeer } from './support/scripted-peer.mjs';

const HELLO_RESULT = {
  protocol: '24.0.0',
  mc_version: '1.21.11',
  supported_mc_versions: ['1.21.11'],
  catalogHash: null,
  world_constants: { y_sea: 62 },
  session: 'test-session',
  player: '00000000-0000-4000-8000-000000000001',
  dimension: 'minecraft:overworld',
  origin: [200, 0, 200],
  permissions: { online: true, offline: false, buildRange: 100 },
  server: { name: 'McRemote', version: '2400.0.0rc1' },
};

test('申告するprotocolは24.0.0', () => {
  assert.equal(PROTOCOL_VERSION, '24.0.0');
});

test('互換判定はmajorの一致とserverのminorが同じか上で、patchは見ない', () => {
  const cases = [
    ['24.0.0', '24.0.0', true],
    ['24.0.0', '24.0.1', true],
    ['24.0.0', '24.1.0', true],
    ['24.1.2', '24.1.0', true],
    ['24.1.2', '24.0.9', false],
    ['24.0.0', '23.3.0', false],
    ['24.0.0', '25.0.0', false],
    ['24.0.0', '24.0', false],
    ['24.0.0', '2400.0.0', false],
  ];
  for (const [client, server, compatible] of cases) {
    assert.equal(isCompatibleProtocol(client, server), compatible, `${client} / ${server}`);
  }
  assert.throws(() => isCompatibleProtocol('24.0', '24.0.0'), RangeError);
});

test('helloで24.0.0を申告し、23.xの成功応答は次のrequestを送らずに閉じる', async () => {
  const steps = [
    { op: 'connect' },
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '24.0.0' } } },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 1, result: { ...HELLO_RESULT, protocol: '23.3.0' } } },
    { op: 'client_close' },
  ];
  const peer = await startPeer(steps, new FakeClock());
  try {
    await Promise.all([
      assert.rejects(connect({ host: '127.0.0.1', port: peer.port }), {
        constructor: ProtocolMismatchError,
        reason: 'protocol_mismatch',
        source: 'client',
        server: '23.3.0',
        clientRequires: '24.0.0',
      }),
      peer.done,
    ]);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
  } finally {
    await peer.close();
  }
});

test('pairingは表示用の情報だけを渡し、expires_inを過ぎてもpendingならPairingExpiredError', async () => {
  const clock = new FakeClock();
  const steps = [
    { op: 'connect' },
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '24.0.0' } } },
    {
      op: 'peer_send',
      message: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth required', data: { reason: 'auth_required' } } },
    },
    { op: 'connect' },
    {
      op: 'client_send',
      message: { jsonrpc: '2.0', id: 1, method: 'auth.pairBegin', params: { token_type: 'session' } },
    },
    {
      op: 'peer_send',
      message: { jsonrpc: '2.0', id: 1, result: { pairing_id: 'test-pairing', pair_code: '123456', expires_in: 1 } },
    },
    {
      op: 'client_send',
      message: { jsonrpc: '2.0', id: 2, method: 'auth.pairPoll', params: { pairing_id: 'test-pairing' } },
    },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 2, result: { status: 'pending' } } },
    { op: 'client_close' },
  ];
  const peer = await startPeer(steps, clock);
  const challenges = [];
  try {
    const attempt = connect({
      host: '127.0.0.1',
      port: peer.port,
      clock,
      onPairing: (challenge) => void challenges.push(challenge),
    });
    await assert.rejects(attempt, (error) => error instanceof PairingExpiredError && error.reason === 'pair_expired');
    await peer.done;
    assert.deepEqual(challenges, [
      { pairCode: '123456', displayCode: '123-456', command: '/mcremote pair 123-456', expiresInSeconds: 1 },
    ]);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
  } finally {
    await peer.close();
  }
});

const authRequired = [
  { op: 'connect' },
  { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '24.0.0' } } },
  {
    op: 'peer_send',
    message: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth required', data: { reason: 'auth_required' } } },
  },
  { op: 'peer_eof' },
];
const pairBegin = [
  { op: 'connect' },
  { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'auth.pairBegin', params: { token_type: 'session' } } },
  {
    op: 'peer_send',
    message: { jsonrpc: '2.0', id: 1, result: { pairing_id: 'test-pairing', pair_code: '123456', expires_in: 120 } },
  },
];
const poll = (id) => ({
  op: 'client_send',
  message: { jsonrpc: '2.0', id, method: 'auth.pairPoll', params: { pairing_id: 'test-pairing' } },
});
const pending = (id) => ({ op: 'peer_send', message: { jsonrpc: '2.0', id, result: { status: 'pending' } } });
// F1-AU-12の、応答の前に切れたpollまで。
const lostPoll = [...authRequired, ...pairBegin, poll(2), pending(2), poll(3), { op: 'peer_eof' }];

// F1-AU-12の先。F1はここをcaseにしていない。
test('2026-11-12-05 応答の前に切れたpollの後、同じpairing_idの次のpollを新しい接続で送り、承認の後にtokenつきのhelloへ進む', async () => {
  const steps = [
    ...lostPoll,
    { op: 'connect' },
    poll(1),
    pending(1),
    { op: 'approve_pairing' },
    poll(2),
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 2, result: { status: 'ok', token: 'test-token' } } },
    { op: 'client_close' },
    { op: 'connect' },
    {
      op: 'client_send',
      message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '24.0.0', auth: { token: 'test-token' } } },
    },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 1, result: HELLO_RESULT } },
  ];
  const clock = new FakeClock();
  const peer = await startPeer(steps, clock);
  let challenges = 0;
  try {
    const remote = await connect({
      host: '127.0.0.1',
      port: peer.port,
      clock,
      credentials: memoryCredentialStore(),
      onPairing: () => void challenges++,
    });
    await peer.done;
    assert.deepEqual(remote.hello, HELLO_RESULT);
    assert.equal(challenges, 1);
    assert.equal(peer.received().filter((message) => message.method === 'auth.pairBegin').length, 1);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
    await remote.close();
  } finally {
    await peer.close();
  }
});

test('2026-11-12-05 続けたpollがpair_not_foundで失敗したら、二度目のpairingをせずにapplicationへ失敗を返す', async () => {
  const steps = [
    ...lostPoll,
    { op: 'connect' },
    poll(1),
    {
      op: 'peer_send',
      message: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'not found', data: { reason: 'pair_not_found' } } },
    },
    { op: 'client_close' },
  ];
  const clock = new FakeClock();
  const peer = await startPeer(steps, clock);
  let challenges = 0;
  try {
    const attempt = connect({ host: '127.0.0.1', port: peer.port, clock, onPairing: () => void challenges++ });
    await Promise.all([
      assert.rejects(attempt, (error) => error instanceof RemoteError && error.reason === 'pair_not_found'),
      peer.done,
    ]);
    assert.equal(challenges, 1);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
  } finally {
    await peer.close();
  }
});

test('setBlockの文字列はstateを指定しないblock IDとして送る', async () => {
  const steps = [
    { op: 'connect' },
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '24.0.0' } } },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 1, result: HELLO_RESULT } },
    {
      op: 'client_send',
      message: { jsonrpc: '2.0', id: 2, method: 'world.setBlock', params: [1, 2, 3, { block_id: 'gold_block', state: {} }] },
    },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 2, result: null } },
    { op: 'client_close' },
  ];
  const peer = await startPeer(steps, new FakeClock());
  try {
    const remote = await connect({ host: '127.0.0.1', port: peer.port });
    assert.deepEqual(remote.hello, HELLO_RESULT);
    assert.equal(await remote.setBlock(1, 2, 3, 'gold_block'), undefined);
    await remote.close();
    await peer.done;
    assert.equal(remote.state, 'closed');
  } finally {
    await peer.close();
  }
});
