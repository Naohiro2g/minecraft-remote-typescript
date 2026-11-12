// 応答の待ち方とつなぎ直し（DECISIONS 2026-11-11-01の②〜⑤、wire 3.4）。F1 v2（operations）は仮想の時計で見る。
// ここでは、実時間の時計と、F1が数値を決めないbackoffなどを見る。
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout } from 'node:timers';

import {
  CompletionUnknownError,
  NotSentError,
  ProtocolMismatchError,
  RemoteError,
  connect,
  memoryCredentialStore,
} from '@mc-remote/client';

import { FakeClock, startPeer } from './support/scripted-peer.mjs';

const LIMIT = { timeout: 5000 };

function helloResult(overrides = {}) {
  return {
    protocol: '23.2.1',
    mc_version: '1.21.11',
    supported_mc_versions: ['1.21.11'],
    catalogHash: null,
    world_constants: { y_sea: 62 },
    session: 'test-session-1',
    player: '00000000-0000-4000-8000-000000000001',
    dimension: 'minecraft:overworld',
    origin: [200, 0, 200],
    permissions: { online: true, offline: false, buildRange: 100 },
    server: 'test-server',
    ...overrides,
  };
}

const send = (id, method, params) => ({ op: 'client_send', message: { jsonrpc: '2.0', id, method, params } });
const reply = (id, result) => ({ op: 'peer_send', message: { jsonrpc: '2.0', id, result } });
const fail = (id, code, message, reason) => ({
  op: 'peer_send',
  message: { jsonrpc: '2.0', id, error: { code, message, data: { reason } } },
});
const pause = (milliseconds) => ({ op: 'pause', milliseconds });
const hello = (params = {}) => send(1, 'hello', { protocol: '23.2.1', ...params });
const AIR = { block_id: 'minecraft:air', state: {} };

// peerとclientを走らせ、最後にpeerのstepsが尽きたことと、stepsに無い送信が無いことを確かめる。
async function withPeer(steps, run, clock = new FakeClock()) {
  const peer = await startPeer(steps, clock);
  const clients = [];
  try {
    await run({
      peer,
      clock,
      connect: async (options) => {
        const remote = await connect({ host: '127.0.0.1', port: peer.port, clock, ...options });
        clients.push(remote);
        return remote;
      },
    });
    await peer.done;
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
  } finally {
    await Promise.all(clients.map((remote) => remote.close()));
    await peer.close();
  }
}

test('③ 最後の受信からresponseTimeoutを超えたら、応答待ちを完了不明にして接続を回収する', LIMIT, async () => {
  const steps = [{ op: 'connect' }, hello(), reply(1, helloResult()), send(2, 'world.getBlock', [0, 0, 0])];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect({ responseTimeout: 100, reconnect: false, clock: undefined });
    const started = performance.now();
    await assert.rejects(remote.getBlock(0, 0, 0), CompletionUnknownError);
    assert.ok(performance.now() - started >= 95, '期限より早く回収した');
    assert.equal(remote.state, 'closed');
  });
});

test('③ 途中で受信するたびに数え直す', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    send(2, 'world.getBlock', [0, 0, 0]),
    send(3, 'world.getBlock', [1, 0, 0]),
    pause(150),
    reply(2, AIR),
    pause(150),
    reply(3, AIR),
  ];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect({ responseTimeout: 250, clock: undefined });
    assert.deepEqual(await Promise.all([remote.getBlock(0, 0, 0), remote.getBlock(1, 0, 0)]), [AIR, AIR]);
  });
});

test('③ 応答待ちが無い間の静けさは数えない', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    send(2, 'world.getBlock', [0, 0, 0]),
    pause(50),
    reply(2, AIR),
  ];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect({ responseTimeout: 100, clock: undefined });
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(await remote.getBlock(0, 0, 0), AIR);
  });
});

test('③ 呼び出しごとにresponseTimeoutを延ばせる', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    send(2, 'world.getBlock', [0, 0, 0]),
    pause(250),
    reply(2, AIR),
  ];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect({ responseTimeout: 100, clock: undefined });
    assert.deepEqual(await remote.getBlock(0, 0, 0, { responseTimeout: 500 }), AIR);
  });
});

test('② 自分で閉じたときも、応答待ちは完了不明になる', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    send(2, 'world.getBlock', [0, 0, 0]),
    { op: 'client_close' },
  ];
  await withPeer(steps, async ({ peer, connect }) => {
    const remote = await connect();
    const pending = remote.getBlock(0, 0, 0);
    // requestがpeerへ届いてから閉じる。
    while (peer.received().length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    await remote.close();
    await assert.rejects(pending, CompletionUnknownError);
    assert.equal(remote.state, 'closed');
  });
});

test('④⑤ 切れた後の次の呼び出しでつなぎ直し、buildを戻し、前のrequestは送り直さない', LIMIT, async () => {
  const nether = { dimension: 'minecraft:the_nether', origin: [10, 64, 10] };
  const steps = [
    { op: 'connect' },
    hello({ build: { dimension: 'the_nether', origin: [0, 64, 0] } }),
    reply(1, helloResult({ dimension: 'minecraft:the_nether', origin: [0, 64, 0] })),
    send(2, 'build.setOrigin', [10, 64, 10]),
    reply(2, nether),
    send(3, 'world.getBlock', [1, 2, 3]),
    { op: 'peer_eof' },
    { op: 'connect' },
    hello({ build: nether }),
    reply(1, helloResult({ ...nether, session: 'test-session-2' })),
    send(2, 'world.getBlock', [4, 5, 6]),
    reply(2, AIR),
  ];
  await withPeer(steps, async ({ connect }) => {
    const events = [];
    const remote = await connect({
      build: { dimension: 'the_nether', origin: [0, 64, 0] },
      onReconnect: (event) => void events.push(event),
    });
    assert.deepEqual(await remote.call('build.setOrigin', [10, 64, 10]), nether);
    await assert.rejects(remote.getBlock(1, 2, 3), CompletionUnknownError);
    await remote.closed;
    assert.equal(remote.state, 'disconnected');

    assert.deepEqual(await remote.getBlock(4, 5, 6), AIR);
    assert.equal(remote.state, 'open');
    assert.equal(remote.hello.session, 'test-session-2');
    assert.equal(events.length, 1);
    assert.equal(events[0].previous.session, 'test-session-1');
    assert.equal(events[0].hello.session, 'test-session-2');
    assert.deepEqual(
      { server: events[0].serverChanged, session: events[0].sessionChanged, catalogHash: events[0].catalogHashChanged },
      { server: false, session: true, catalogHash: false },
    );
  });
});

test('⑤E 同時の呼び出しでも、つなぎ直しは1回', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    { op: 'peer_eof' },
    { op: 'connect' },
    hello({ build: { dimension: 'minecraft:overworld', origin: [200, 0, 200] } }),
    reply(1, helloResult({ session: 'test-session-2' })),
    send(2, 'world.getBlock', [0, 0, 0]),
    send(3, 'world.getBlock', [1, 0, 0]),
    reply(2, AIR),
    reply(3, AIR),
  ];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect();
    await remote.closed;
    assert.deepEqual(await Promise.all([remote.getBlock(0, 0, 0), remote.getBlock(1, 0, 0)]), [AIR, AIR]);
  });
});

test('⑤A⑤F つなぎ直せなければ未送信。間隔はばらつかせながら延ばし、期限で諦める', LIMIT, async () => {
  const steps = [{ op: 'connect' }, hello(), reply(1, helloResult())];
  const reconnect = { initialDelay: 100, maxDelay: 400, giveUpAfter: 2000 };
  await withPeer(steps, async ({ peer, clock, connect }) => {
    const remote = await connect({ reconnect });
    await peer.done;
    await peer.close();
    await remote.closed;

    const error = await remote.getBlock(0, 0, 0).then(
      () => assert.fail('閉じたportへつなぎ直せた'),
      (caught) => caught,
    );
    assert.ok(error instanceof NotSentError, `NotSentErrorでない: ${error}`);
    assert.ok(!(error instanceof CompletionUnknownError));
    assert.equal(error.reason, undefined);

    assert.ok(clock.slept.length >= 3, `つなぎ直しが少ない: ${clock.slept}`);
    let ceiling = reconnect.initialDelay;
    for (const slept of clock.slept) {
      assert.ok(slept >= ceiling / 2 && slept <= ceiling, `${slept}が${ceiling / 2}〜${ceiling}の外`);
      ceiling = Math.min(ceiling * 2, reconnect.maxDelay);
    }
    assert.ok(clock.slept.reduce((sum, slept) => sum + slept, 0) <= reconnect.giveUpAfter);
    assert.notEqual(new Set(clock.slept.slice(-3)).size, 1, 'ばらついていない');
  });
});

test('⑤D⑦ つなぎ直しでauth_requiredになったら、onPairingがあってもpairingせずに止める', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello({ auth: { token: 'mcrs_test_stored' } }),
    reply(1, helloResult()),
    { op: 'peer_eof' },
    { op: 'connect' },
    hello({ auth: { token: 'mcrs_test_stored' }, build: { dimension: 'minecraft:overworld', origin: [200, 0, 200] } }),
    fail(1, -32000, 'token expired', 'token_expired'),
    { op: 'peer_eof' },
    { op: 'connect' },
    hello({ build: { dimension: 'minecraft:overworld', origin: [200, 0, 200] } }),
    fail(1, -32000, 'auth required', 'auth_required'),
    { op: 'peer_eof' },
  ];
  await withPeer(steps, async ({ peer, connect }) => {
    const credentials = memoryCredentialStore();
    const key = { application: '', credentialType: 'session', transport: 'tcp', target: `127.0.0.1:${peer.port}` };
    await credentials.save(key, 'mcrs_test_stored');
    const challenges = [];
    const remote = await connect({ credentials, onPairing: (challenge) => void challenges.push(challenge) });
    await remote.closed;

    const error = await remote.getBlock(0, 0, 0).then(
      () => assert.fail('pairingの要るserverへつなぎ直せた'),
      (caught) => caught,
    );
    assert.ok(error instanceof NotSentError, `NotSentErrorでない: ${error}`);
    assert.ok(error.cause instanceof RemoteError && error.cause.reason === 'auth_required', `${error.cause}`);
    assert.deepEqual(challenges, []);
    assert.equal(await credentials.load(key), undefined);
    assert.equal(remote.state, 'disconnected');
  });
});

test('⑤C つなぎ直したhelloの版が合わなければ、送らずに閉じて未送信にする', LIMIT, async () => {
  const steps = [
    { op: 'connect' },
    hello(),
    reply(1, helloResult()),
    { op: 'peer_eof' },
    { op: 'connect' },
    hello({ build: { dimension: 'minecraft:overworld', origin: [200, 0, 200] } }),
    reply(1, helloResult({ protocol: '24.0.0' })),
    { op: 'client_close' },
  ];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect();
    await remote.closed;
    const error = await remote.getBlock(0, 0, 0).then(
      () => assert.fail('互換でないserverへ送った'),
      (caught) => caught,
    );
    assert.ok(error instanceof NotSentError, `NotSentErrorでない: ${error}`);
    assert.ok(error.cause instanceof ProtocolMismatchError && error.cause.source === 'client', `${error.cause}`);
  });
});

test('⑤ reconnect: falseなら、切れた後の呼び出しはつながずに未送信', LIMIT, async () => {
  const steps = [{ op: 'connect' }, hello(), reply(1, helloResult()), { op: 'peer_eof' }];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect({ reconnect: false });
    await remote.closed;
    assert.equal(remote.state, 'closed');
    await assert.rejects(remote.getBlock(0, 0, 0), NotSentError);
  });
});

test('⑤ applicationが閉じた後は、つなぎ直さない', LIMIT, async () => {
  const steps = [{ op: 'connect' }, hello(), reply(1, helloResult()), { op: 'client_close' }];
  await withPeer(steps, async ({ connect }) => {
    const remote = await connect();
    await remote.close();
    assert.equal(remote.state, 'closed');
    await assert.rejects(remote.getBlock(0, 0, 0), NotSentError);
  });
});
