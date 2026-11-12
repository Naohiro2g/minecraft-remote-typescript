// 共有fixture F1 v2（client-bootstrap-operations、protocol 23.2.1）の全caseを、このclientで確かめる。
// 形式はminecraft-remote-toolingの`packages/protocol/CLIENT_BOOTSTRAP_V2_ja.md`（取得元のcommitは
// test/fixtures/protocol/SOURCE_ja.md）。bytesとdigestは client-bootstrap-fixture.test.mjs が確かめる。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import {
  CompletionUnknownError,
  ConnectionError,
  NotSentError,
  PairingExpiredError,
  ProtocolMismatchError,
  RemoteError,
  connect,
} from '@mc-remote/client';

import { RpcConnection } from '../dist/rpc.js';
import { VirtualClock, closedPort, within, wrapSocket } from './support/scripted-peer.mjs';

const FIXTURE_DIR = new URL('./fixtures/protocol/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, FIXTURE_DIR), 'utf8'));

const schema = readJson('client-bootstrap-v2.schema.json');
const fixture = readJson('client-bootstrap-operations-v23.2.1.json');

// `receive_idle`に当てる、このrunnerのresponseTimeout（ms）。fixtureは割合だけを決める。
const RESPONSE_TIMEOUT = 60_000;

// 入力の後、その時刻で進められる処理（localhostの送受信を含む）を待つ実時間（ms）。
const SETTLE_MS = 30;

// このclientに無い機能やcaseの読み方の違いに当たるcase。runnerは最後まで走らせ、当たったところで失敗する。
// node:testのtodoとして報告し、合格には数えない。
const NOT_YET = {
  'F1-OP-06': 'FAST（idなしのworld.setBlock）と、connection.flushが保証する範囲を、このclientはまだ持たない',
  'F1-OP-08':
    'このclientはauth_requiredの後のpairingを別の接続で行う（F1-AU-01の形）。このcaseはhelloと同じ接続でpairingする',
  'F1-OP-11': 'entity handle、event cursor、catalogのcacheを、このclientはまだ持たない',
};

test('v2のfixtureがschemaの形に沿い、caseが12件そろう', () => {
  const stepOps = collectConsts(schema, 'op');
  assert.equal(fixture.schema, schema.properties.schema.const);
  assert.equal(fixture.protocol, schema.properties.protocol.const);
  assert.equal(fixture.cases.length, 12);
  const ids = new Set();
  for (const testCase of fixture.cases) {
    assert.match(testCase.id, /^F1-OP-[0-9]{2}$/);
    assert.ok(!ids.has(testCase.id), `重複したID ${testCase.id}`);
    ids.add(testCase.id);
    for (const step of testCase.steps) {
      assert.ok(stepOps.has(step.op), `${testCase.id}: 未知のop ${step.op}`);
    }
  }
  for (const id of Object.keys(NOT_YET)) assert.ok(ids.has(id), id);
});

for (const testCase of fixture.cases) {
  const options = NOT_YET[testCase.id] ? { todo: NOT_YET[testCase.id] } : {};
  test(`${testCase.id} ${testCase.title}`, options, () => runCase(testCase));
}

async function runCase(testCase) {
  const harness = await startHarness(testCase);
  try {
    for (const [index, step] of testCase.steps.entries()) {
      await harness.apply(step, `${testCase.id} step ${index} (${step.op})`);
    }
    await settle();
    harness.check(testCase.expected, `${testCase.id}: expected`);
  } finally {
    await harness.close();
  }
}

async function startHarness(testCase) {
  const { steps } = testCase;
  const clock = new VirtualClock();
  const firstHello = steps.find((step) => step.op === 'expect_send' && step.message.method === 'hello').message;
  const pairs = steps.some((step) => step.message?.method === 'auth.pairBegin');
  // `connect_error`を受ける接続と、その後の接続は、受けないportへ向ける。
  const named = steps.filter((step) => step.op === 'expect_connect').map((step) => step.connection);
  const refused = steps.filter((step) => step.op === 'connect_error').map((step) => named.indexOf(step.connection));
  const refuseFrom = refused.length > 0 ? Math.min(...refused) : Infinity;
  const refusingPort = await closedPort();

  // peer。受けた接続は、clientのlocal portで、clientが開いた接続と対応させる。
  const accepted = new Map();
  const server = net.createServer((socket) => {
    accepted.set(socket.remotePort, wrapSocket(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // clientが開いた接続（`connect_attempts`）。RPC層とsocketを観測する。
  const dials = [];
  const { open } = RpcConnection;
  const createConnection = net.createConnection;
  RpcConnection.open = async function (host, port, options) {
    const dial = { rpc: undefined, socket: undefined, localPort: undefined, failed: false };
    dials.push(dial);
    try {
      dial.rpc = await open.call(this, host, dials.length - 1 >= refuseFrom ? refusingPort : port, options);
      return dial.rpc;
    } catch (error) {
      dial.failed = true;
      throw error;
    }
  };
  net.createConnection = function (...args) {
    const socket = createConnection.apply(this, args);
    const dial = dials.at(-1);
    dial.socket = socket;
    // 閉じるとlocalPortは読めなくなるので、つながった時に覚える。
    socket.once('connect', () => {
      dial.localPort = socket.localPort;
    });
    return socket;
  };

  const connections = new Map();
  const calls = new Map();
  const events = [];
  const adopted = new Set();
  const ttl = new Map();
  let current;
  let client;

  const dialOf = (name) => {
    const dial = connections.get(name);
    assert.ok(dial, `名付けていない接続 ${name}`);
    return dial;
  };
  const peerOf = async (name, where) => {
    const dial = dialOf(name);
    return within(
      until(() => accepted.get(dial.localPort)),
      `${where}: ${name}をpeerが受けていない`,
    );
  };
  const lastOpened = () => dials.findLast((dial) => dial.rpc !== undefined)?.rpc;

  const startCall = (name, promise, request) => {
    const call = { request, state: 'pending', connection: undefined };
    calls.set(name, call);
    promise.then(
      (value) => {
        call.state = 'fulfilled';
        call.value = value;
      },
      (error) => {
        call.state = 'rejected';
        call.error = error;
      },
    );
  };

  const apply = async (step, where) => {
    switch (step.op) {
      case 'app_connect': {
        const token = firstHello.params.auth?.token;
        startCall(
          step.call,
          connect({
            host: '127.0.0.1',
            port: server.address().port,
            protocol: firstHello.params.protocol,
            client: firstHello.params.client,
            build: firstHello.params.build,
            credentials: seededStore(token),
            clock,
            responseTimeout: RESPONSE_TIMEOUT,
            ...(pairs && { onPairing: () => {} }),
            onReconnect: (event) => {
              const previous = current;
              current = lastOpened();
              adopted.add(current);
              const names = { connection: current, previous_connection: previous };
              // ReconnectEventは、つなぎ直したことと、切れていた間のeventを失ったことを知らせる。
              events.push({ kind: 'reconnected', ...names }, { kind: 'events_lost', ...names });
              if (event.serverChanged) events.push({ kind: 'server_changed', ...names });
              if (event.sessionChanged) events.push({ kind: 'session_changed', ...names });
            },
          }).then((remote) => {
            client = remote;
            current = lastOpened();
            adopted.add(current);
            return remote;
          }),
        );
        break;
      }
      case 'app_call': {
        assert.equal(step.mode, 'DEBUG', `${where}: FASTはこのclientに無い`);
        assert.ok(client, `${where}: 接続していない`);
        startCall(step.call, invoke(client, step.method, step.params), { method: step.method, params: step.params });
        break;
      }
      case 'expect_connect': {
        const dial = await within(
          until(() => dials[connections.size]),
          `${where}: clientが${step.connection}を開かない`,
        );
        connections.set(step.connection, dial);
        break;
      }
      case 'expect_send': {
        const peer = await peerOf(step.connection, where);
        const message = JSON.parse(await within(peer.nextLine(), `${where}: ${step.connection}から送信が来ない`));
        assert.deepEqual(message, step.message, where);
        // requestを運んだ接続を、まだ決まっていない同じmethodとparamsの呼び出しに結びつける。
        const call = [...calls.values()].find(
          (entry) =>
            entry.request?.method === message.method &&
            entry.connection === undefined &&
            isDeepStrictEqual(entry.request.params, message.params),
        );
        if (call) call.connection = step.connection;
        break;
      }
      case 'peer_send': {
        const peer = await peerOf(step.connection, where);
        peer.socket.write(`${JSON.stringify(step.message)}\n`);
        if (typeof step.message.result?.expires_in === 'number') {
          ttl.set(step.connection, step.message.result.expires_in * 1000);
        }
        break;
      }
      case 'peer_eof':
        (await peerOf(step.connection, where)).socket.end();
        break;
      case 'socket_error':
        dialOf(step.connection).socket.destroy(injectedError('ECONNRESET', 'injected socket error'));
        break;
      case 'liveness_lost':
        // keepaliveの応答が来ないとき、Node.jsはETIMEDOUTでsocketを壊す。
        dialOf(step.connection).socket.destroy(injectedError('ETIMEDOUT', 'keepalive probes were not answered'));
        break;
      case 'connect_error':
        assert.equal(step.terminal, true, `${where}: terminalでないconnect_errorは扱わない`);
        // 以後の接続はすべて断られる。つなぎ直しのpolicyが諦めるまで、待つ時計を進める。
        await runPolicyToEnd(clock, calls, where);
        break;
      case 'advance_clock': {
        const length = step.timer === 'receive_idle' ? RESPONSE_TIMEOUT : ttl.get(step.connection);
        assert.ok(length, `${where}: ${step.timer}の長さが分からない`);
        clock.advance((length * step.fraction.numerator) / step.fraction.denominator);
        break;
      }
      case 'observe':
        await settle();
        check(step.expected, where);
        return;
      case 'seed_epoch_state':
        assert.fail(`${where}: entity handle、event cursor、catalogのcacheを、このclientは持たない`);
        break;
      default:
        assert.fail(`${where}: runnerが扱わないop`);
    }
    await settle();
  };

  const nameOf = (rpc) => [...connections].find(([, dial]) => dial.rpc === rpc)?.[0];

  const observeCall = (name) => {
    const call = calls.get(name);
    assert.ok(call, `呼び出していない ${name}`);
    const row = { call: name };
    if (call.state === 'pending') return { ...row, outcome: 'pending', source: 'client' };
    if (call.state === 'fulfilled') {
      return call.request
        ? { ...row, outcome: 'success', source: 'server', connection: call.connection }
        : { ...row, outcome: 'success', source: 'client' };
    }
    const { error } = call;
    if (error instanceof CompletionUnknownError) return { ...row, outcome: 'completion_unknown', source: 'client' };
    if (error instanceof NotSentError) {
      return { ...row, outcome: 'not_sent', source: 'client', cause: notSentCause(error.cause) };
    }
    if (error instanceof PairingExpiredError) {
      return { ...row, outcome: 'pairing_expired', source: 'client', equivalent_to: 'pair_expired' };
    }
    if (error instanceof RemoteError) return { ...row, outcome: 'server_error', source: 'server', error: error.toJSON() };
    throw error;
  };

  const observeConnection = (name) => {
    const dial = dialOf(name);
    if (dial.failed) return { connection: name, state: 'failed', sent_count: 0, pending_ids: [] };
    const peer = accepted.get(dial.localPort);
    return {
      connection: name,
      state: dial.rpc.state,
      sent_count: peer?.received().length ?? 0,
      pending_ids: dial.rpc.pendingIds,
    };
  };

  // 成功形のhelloの後、clientが使い始めた接続は互換。使わずに版の失敗にした接続は非互換。
  const observeNegotiation = (name) => {
    const { rpc } = dialOf(name);
    if (adopted.has(rpc)) return { connection: name, compatible: true };
    const refusedVersion = [...calls.values()].some(
      (call) => call.error instanceof NotSentError && notSentCause(call.error.cause) === 'incompatible_protocol',
    );
    return { connection: name, ...(refusedVersion && rpc === lastOpened() && { compatible: false }) };
  };

  const check = (expected, where) => {
    for (const [key, rows] of Object.entries(expected)) {
      const at = `${where}.${key}`;
      switch (key) {
        // 記載した行だけを比べる。connectionsは、記載した欄だけを比べる（CLIENT_BOOTSTRAP_V2の「expectedの欄」）。
        case 'calls':
          for (const row of rows) assert.deepEqual(observeCall(row.call), row, at);
          break;
        case 'connections':
          for (const row of rows) {
            const observed = observeConnection(row.connection);
            assert.deepEqual(pick(observed, Object.keys(row)), row, at);
          }
          break;
        case 'negotiations':
          for (const row of rows) assert.deepEqual(observeNegotiation(row.connection), row, at);
          break;
        case 'events': {
          const observed = events.map((event) => ({
            ...event,
            connection: nameOf(event.connection),
            previous_connection: nameOf(event.previous_connection),
          }));
          for (const row of rows) {
            assert.ok(
              observed.some((event) => isDeepStrictEqual(event, row)),
              `${at}: ${JSON.stringify(row)}が無い。観測: ${JSON.stringify(observed)}`,
            );
          }
          break;
        }
        case 'connect_attempts':
          assert.equal(dials.length, rows, at);
          break;
        default:
          assert.fail(`${at}: runnerが確かめないexpected`);
      }
    }
  };

  return {
    apply,
    check,
    async close() {
      RpcConnection.open = open;
      net.createConnection = createConnection;
      await client?.close();
      for (const peer of accepted.values()) peer.socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 呼び出しがすべて終わるまで、つなぎ直しの待ちを一つずつ進める。待ちの長さと回数はclientのpolicyが決める。
async function runPolicyToEnd(clock, calls, where) {
  for (let turn = 0; turn < 1000; turn++) {
    await settle();
    if (![...calls.values()].some((call) => call.state === 'pending')) return;
    const next = clock.untilNextTimer();
    assert.notEqual(next, undefined, `${where}: 待ちが無いのに呼び出しが終わらない`);
    clock.advance(next);
  }
  assert.fail(`${where}: つなぎ直しのpolicyが終わらない`);
}

function notSentCause(cause) {
  if (cause instanceof ProtocolMismatchError && cause.source === 'client') return 'incompatible_protocol';
  if (cause instanceof RemoteError && cause.reason === 'auth_required') return 'pairing_required';
  if (cause instanceof ConnectionError) return 'connection_failed';
  return `unclassified: ${cause}`;
}

function invoke(client, method, params) {
  switch (method) {
    case 'world.setBlock':
      return client.setBlock(params[0], params[1], params[2], params[3]);
    case 'world.getBlock':
      return client.getBlock(params[0], params[1], params[2]);
    default:
      return client.call(method, params);
  }
}

// 用意したtokenを、どのkeyにも返すstore。
function seededStore(token) {
  let current = token;
  return {
    load: () => current,
    save: (_key, next) => {
      current = next;
    },
    delete: () => {
      current = undefined;
    },
  };
}

function injectedError(code, message) {
  return Object.assign(new Error(message), { code });
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

// probeが値を返すまで待つ。来なければ、包んだwithin()が先に失敗する。
async function until(probe) {
  const deadline = performance.now() + 2500;
  while (performance.now() < deadline) {
    const value = probe();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

// schemaの中の`{ properties: { op: { const } } }`をすべて集める。
function collectConsts(node, name, found = new Set()) {
  if (Array.isArray(node)) {
    for (const item of node) collectConsts(item, name, found);
  } else if (node && typeof node === 'object') {
    if (typeof node.properties?.[name]?.const === 'string') found.add(node.properties[name].const);
    for (const value of Object.values(node)) collectConsts(value, name, found);
  }
  return found;
}
