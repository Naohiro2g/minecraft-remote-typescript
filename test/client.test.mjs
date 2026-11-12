// F1の外で、このclientの振る舞いを確かめる。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PROTOCOL_VERSION,
  PairingExpiredError,
  RemoteError,
  connect,
  isCompatibleProtocol,
  memoryCredentialStore,
} from '@mc-remote/client';

import { FakeClock, VirtualClock, startPeer } from './support/scripted-peer.mjs';

const HELLO_RESULT = {
  protocol: '23.2.1',
  mc_version: '1.21.11',
  supported_mc_versions: ['1.21.11'],
  catalogHash: null,
  world_constants: { y_sea: 62 },
  session: 'test-session',
  player: '00000000-0000-4000-8000-000000000001',
  dimension: 'minecraft:overworld',
  origin: [200, 0, 200],
  permissions: { online: true, offline: false, buildRange: 100 },
  server: 'test-server',
};

test('申告するprotocolは23.2.1', () => {
  assert.equal(PROTOCOL_VERSION, '23.2.1');
});

test('互換判定はmajorの一致とserverのminorが同じか上で、patchは見ない', () => {
  const cases = [
    ['23.2.1', '23.2.1', true],
    ['23.2.1', '23.2.0', true],
    ['23.2.1', '23.3.0', true],
    ['23.2.1', '23.1.9', false],
    ['23.2.1', '24.2.1', false],
    ['23.2.1', '22.9.9', false],
    ['23.2.1', '23.2', false],
    ['23.2.1', '2321.1.0', false],
  ];
  for (const [client, server, compatible] of cases) {
    assert.equal(isCompatibleProtocol(client, server), compatible, `${client} / ${server}`);
  }
  assert.throws(() => isCompatibleProtocol('23.2', '23.2.1'), RangeError);
});

test('pairingは表示用の情報だけを渡し、expires_inを過ぎてもpendingならPairingExpiredError', async () => {
  const clock = new FakeClock();
  const steps = [
    { op: 'connect' },
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '23.2.1' } } },
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

// F1-OP-08はhelloと同じ接続でpairingするので、このclientの形（別の接続）で同じ判断を見る。
test('⑧ 待つ間にexpires_inを過ぎたら、次のpollを送らずにclientが期限切れと判断する', async () => {
  const clock = new VirtualClock();
  const steps = [
    { op: 'connect' },
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '23.2.1' } } },
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
      message: { jsonrpc: '2.0', id: 1, result: { pairing_id: 'test-pairing', pair_code: '123456', expires_in: 120 } },
    },
    {
      op: 'client_send',
      message: { jsonrpc: '2.0', id: 2, method: 'auth.pairPoll', params: { pairing_id: 'test-pairing' } },
    },
    { op: 'peer_send', message: { jsonrpc: '2.0', id: 2, result: { status: 'pending' } } },
    // clientがpollの間隔を待ち始めてから、時計を進める。
    { op: 'pause', milliseconds: 50 },
    { op: 'advance_time', milliseconds: 150_000 },
    { op: 'client_close' },
  ];
  const peer = await startPeer(steps, clock);
  try {
    const attempt = connect({ host: '127.0.0.1', port: peer.port, clock, onPairing: () => {} });
    // peerが先に失敗したら、clientを待たずに閉じる。
    await Promise.all([
      assert.rejects(attempt, (error) => error instanceof PairingExpiredError && !(error instanceof RemoteError)),
      peer.done,
    ]);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
  } finally {
    await peer.close();
  }
});

const authRequired = [
  { op: 'connect' },
  { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '23.2.1' } } },
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
      message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '23.2.1', auth: { token: 'test-token' } } },
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
    { op: 'client_send', message: { jsonrpc: '2.0', id: 1, method: 'hello', params: { protocol: '23.2.1' } } },
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
