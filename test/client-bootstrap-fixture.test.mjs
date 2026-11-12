// 共有fixture F1（client bootstrap、protocol 23.2.1）の全caseを、このclientで確かめる。
// 取得元とdigestは test/fixtures/protocol/SOURCE_ja.md。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setTimeout } from 'node:timers';
import { URL } from 'node:url';

import {
  CompletionUnknownError,
  ConnectionError,
  ProtocolMismatchError,
  RemoteError,
  connect,
  memoryCredentialStore,
} from '@mc-remote/client';

import { LineDecoder } from '../dist/framing.js';
import { RpcConnection } from '../dist/rpc.js';
import { FakeClock, closedPort, startPeer } from './support/scripted-peer.mjs';

const FIXTURE_DIR = new URL('./fixtures/protocol/', import.meta.url);

const PINNED = {
  'client-bootstrap-framing-v23.2.1.json': [15131, 'be063b519b5d653a4bb4ec3da6f67e5d481a28dcf5913961c848b2b909d4b26d'],
  'client-bootstrap-hello-v23.2.1.json': [20913, '78297f05eb4352b0dabffab3242e933c1e68cb192bbb6d242019c7956c809d57'],
  'client-bootstrap-pairing-v23.2.1.json': [35577, '5864c23ef3f31af6134d36770cab80b569b708b35fd3fdbed69fb6db195e3aeb'],
  'client-bootstrap-blocks-v23.2.1.json': [45945, '664babdf3131a74e4aaf6d9e5dfb5e4cfc6e197df0a0d48142688820f1be813d'],
  'client-bootstrap-errors-v23.2.1.json': [9179, 'c458d3ffbae846cfb33c032eba14d8f0005c6a1fbe871290b53fcfec8ec41aaa'],
  'client-bootstrap-close-v23.2.1.json': [14884, 'a030cc72aa0e4f41575cb15610b1e06e941d3eab07157ce47f0eafe744475154'],
  'client-bootstrap-v1.schema.json': [10916, '8c3e4ff6e7b5b0cf438d358578096579dafab699a40df9cd56de7b9513837413'],
  'block-value-v22.json': [3217, 'e8e108d59c40751d67a432543d75cb4bf9146ef9781721012085c80545b854f3'],
  LICENSE: [1070, 'aa329a0bafc839b95124306141db13a381de45818bf629e983c44ea55ab5a7fb'],
};

const SUITE_CASES = { framing: 7, hello: 10, pairing: 10, blocks: 12, errors: 3, close: 6 };

// 公開APIに無い操作（hello前のenvelope、発行paramsの拒否、別のpairing_id）を送るcaseは、RPC層で再生する。
const RAW_CASES = new Set(['F1-FR-07', 'F1-AU-03', 'F1-AU-04']);

// stepsがtokenを捨てたところで終わるcase。clientはその後、tokenなしのhelloへ戻る（DECISIONS 2026-11-11-01⑦）が、
// caseはその接続を書いていない。runnerは、その接続でtokenなしのhelloが来たことを確かめて閉じ、
// `reason`はstepsの中でclientが受けたerrorから読む。
const ENDS_BEFORE_FALLBACK = new Set(['F1-AU-07']);

const readFixture = (name) => readFileSync(new URL(name, FIXTURE_DIR));
const readJson = (name) => JSON.parse(readFixture(name).toString('utf8'));

const schema = readJson('client-bootstrap-v1.schema.json');
const blockValues = readJson('block-value-v22.json');
const suites = Object.keys(SUITE_CASES).map((suite) => readJson(`client-bootstrap-${suite}-v23.2.1.json`));

test('fixtureのbytesが固定したdigestと一致する', () => {
  for (const [name, [size, sha256]] of Object.entries(PINNED)) {
    const bytes = readFixture(name);
    assert.equal(bytes.length, size, name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, name);
  }
});

test('fixtureがschemaの形に沿い、caseが48件そろう', () => {
  const ops = new Set(schema.properties.cases.items.properties.steps.items.properties.op.enum);
  const expectedKeys = new Set(Object.keys(schema.properties.cases.items.properties.expected.properties));
  const ids = new Set();
  for (const fixture of suites) {
    assert.equal(fixture.schema, schema.properties.schema.const);
    assert.equal(fixture.protocol, schema.properties.protocol.const);
    assert.equal(fixture.cases.length, SUITE_CASES[fixture.suite], fixture.suite);
    for (const testCase of fixture.cases) {
      assert.match(testCase.id, /^F1-[A-Z]{2}-[0-9]{2}$/);
      assert.ok(!ids.has(testCase.id), `重複したID ${testCase.id}`);
      ids.add(testCase.id);
      for (const step of testCase.steps) {
        assert.ok(ops.has(step.op), `${testCase.id}: 未知のop ${step.op}`);
      }
      for (const key of Object.keys(testCase.expected)) {
        assert.ok(expectedKeys.has(key), `${testCase.id}: 未知のexpected ${key}`);
      }
    }
  }
  assert.equal(ids.size, 48);
});

test('value_refsが同じディレクトリの値を指す', () => {
  for (const testCase of suites.flatMap((fixture) => fixture.cases)) {
    for (const ref of testCase.value_refs ?? []) {
      assert.notEqual(resolvePointer(readJson(ref.file), ref.pointer), undefined, `${testCase.id}: ${ref.pointer}`);
    }
  }
});

for (const fixture of suites) {
  for (const testCase of fixture.cases) {
    test(`${testCase.id} ${testCase.title}`, () => runCase(fixture.suite, testCase));
  }
}

async function runCase(suite, testCase) {
  let observed;
  if (!testCase.steps.some((step) => step.op === 'connect' || step.op === 'connect_error')) {
    observed = decodeBytes(testCase.steps);
  } else if (testCase.steps[0].op === 'connect_error') {
    observed = await connectToClosedPort();
  } else if (RAW_CASES.has(testCase.id)) {
    observed = await replayRaw(testCase.steps);
  } else {
    observed = await runDialog(testCase.steps, { endsBeforeFallback: ENDS_BEFORE_FALLBACK.has(testCase.id) });
  }
  checkExpected(suite, testCase, observed);
}

function decodeBytes(steps) {
  const decoder = new LineDecoder();
  const frames = [];
  for (const step of steps) {
    assert.equal(step.op, 'peer_bytes');
    frames.push(...decoder.push(Buffer.from(step.bytes_hex, 'hex')));
  }
  return { frames, tail_hex: Buffer.from(decoder.tail).toString('hex') };
}

async function connectToClosedPort() {
  const port = await closedPort();
  const error = await connect({ host: '127.0.0.1', port }).then(
    () => assert.fail('閉じたportへの接続が成功した'),
    (caught) => caught,
  );
  assert.ok(error instanceof ConnectionError, `ConnectionErrorでない: ${error}`);
  return { connection: 'failed', completed_ids: [] };
}

// fixtureのclient_sendをRPC層でそのまま送る。応答を待たずに送り、最後にそろえる。
async function replayRaw(steps) {
  const clock = new FakeClock();
  const peer = await startPeer(steps, clock);
  const connections = [];
  const requests = [];
  const matched = [];
  const ignored = [];
  let lastRemoteError;
  try {
    for (const step of steps) {
      if (step.op === 'connect') {
        connections.push(
          await RpcConnection.open('127.0.0.1', peer.port, {
            onDiscard: (frame, why) => {
              if (why === 'unknown_id') ignored.push(frame.id);
            },
          }),
        );
      } else if (step.op === 'client_send') {
        const { id, method, params } = step.message;
        const request = connections.at(-1).request(method, params).then(
          () => matched.push(id),
          (error) => {
            if (!(error instanceof RemoteError)) throw error;
            matched.push(id);
            lastRemoteError = error;
          },
        );
        requests.push(request);
      } else if (step.op === 'client_close') {
        await connections.at(-1).close();
      }
    }
    await peer.done;
    await Promise.all(requests);
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
    return {
      reason: lastRemoteError?.reason,
      matched_ids: matched,
      ignored_ids: ignored,
      pending_ids: connections.at(-1).pendingIds,
    };
  } finally {
    await Promise.all(connections.map((connection) => connection.close()));
    await peer.close();
  }
}

// 拒まれたhelloの後も、同じ接続試行のままhelloかpairingへ進むreason（wire 6.5）。
const AUTH_RETRY_REASONS = new Set(['token_expired', 'token_revoked', 'token_not_found', 'token_invalid', 'auth_required']);

// fixtureの対話を、公開APIの操作の列に読み替える。pairingの内側の接続とmessage、認証reasonの後のhelloは、
// connect()が自分で行う。
function planDialog(steps) {
  const actions = [];
  let inPairing = false;
  let pairedHelloSent = false;
  let helloSent = false;
  let sameAttempt = false;
  for (const step of steps) {
    if (step.op === 'client_send') {
      const { id, method, params } = step.message;
      if (method === 'auth.pairBegin' || method === 'auth.pairPoll') {
        inPairing = true;
      } else if (method === 'hello') {
        if (inPairing) {
          pairedHelloSent = true;
        } else if (!sameAttempt) {
          actions.push({ kind: 'connect', id, params });
        }
        helloSent = true;
        sameAttempt = false;
      } else {
        actions.push({ kind: 'call', id, method, params });
      }
    } else if (step.op === 'peer_send' && helloSent) {
      helloSent = false;
      sameAttempt = AUTH_RETRY_REASONS.has(step.message.error?.data?.reason);
      if (pairedHelloSent) {
        inPairing = false;
        pairedHelloSent = false;
      }
    } else if (step.op === 'client_close' && !inPairing) {
      actions.push({ kind: 'close' });
    }
  }
  return actions;
}

async function runDialog(steps, { endsBeforeFallback = false } = {}) {
  const clock = new FakeClock();
  const peer = await startPeer(steps, clock);
  const received = observeRemoteErrors();
  const credentials = recordingStore();
  const pairs = steps.some((step) => step.message?.method === 'auth.pairBegin');
  const challenges = [];
  const clients = [];
  const calls = [];
  const matched = [];
  const localFailures = [];
  let lastClient;
  let lastResult;
  let lastError;
  let compatible;
  let connection;

  // peerが先に失敗したら接続を閉じ、応答待ちのclientを解く。
  const peerDone = (endsBeforeFallback ? peer.done.then(() => closeFallbackHello(peer)) : peer.done).catch(async (error) => {
    await peer.close();
    throw error;
  });

  const drive = async () => {
    for (const action of planDialog(steps)) {
      if (action.kind === 'connect') {
        const { params } = action;
        if (params.auth && (await credentials.peek()) === undefined) {
          credentials.seed(params.auth.token);
        }
        const call = track(calls, action.id, 'connect');
        try {
          lastClient = await connect({
            host: '127.0.0.1',
            port: peer.port,
            protocol: params.protocol,
            ...(params.client && { client: params.client }),
            ...(params.build && { build: params.build }),
            credentials,
            clock,
            ...(pairs && { onPairing: (challenge) => void challenges.push(challenge) }),
          });
          clients.push(lastClient);
          call.settle('response');
          lastResult = lastClient.hello;
          compatible = true;
          connection = undefined;
        } catch (error) {
          call.settle(error instanceof ConnectionError ? 'closed' : 'response');
          lastError = error;
          lastClient = undefined;
          if (error instanceof ProtocolMismatchError && error.source === 'client') compatible = false;
          connection = error instanceof ConnectionError ? 'failed' : 'closed';
        }
      } else if (action.kind === 'close') {
        await lastClient.close();
      } else {
        const call = track(calls, action.id, action.method);
        try {
          lastResult = await invoke(lastClient, action.method, action.params);
          call.settle('response');
          matched.push(action.id);
        } catch (error) {
          lastError = error;
          if (error instanceof RemoteError) {
            call.settle('response');
            matched.push(action.id);
          } else if (error instanceof ConnectionError) {
            call.settle('closed');
            if (error instanceof CompletionUnknownError) {
              localFailures.push({ id: action.id, outcome: 'completion_unknown' });
            }
          } else {
            throw error;
          }
        }
      }
    }
  };

  try {
    const [peerOutcome, driveOutcome] = await Promise.allSettled([peerDone, drive()]);
    if (peerOutcome.status === 'rejected') throw peerOutcome.reason;
    if (driveOutcome.status === 'rejected') throw driveOutcome.reason;
    if (lastClient) {
      // peer_eofの後、clientが閉じたことを観測できるまで少し待つ。
      await Promise.race([lastClient.closed, new Promise((resolve) => setTimeout(resolve, 100))]);
    }
    assert.deepEqual(peer.unexpected(), { lines: [], connections: 0 });
    const lastConnection = calls.findLastIndex((call) => call.kind === 'connect');
    const current = calls.slice(Math.max(lastConnection, 0));
    const token = await credentials.peek();
    return {
      result: lastResult,
      reason: endsBeforeFallback ? received.reasons.at(-1) : lastError?.reason,
      error: lastError instanceof RemoteError ? lastError.toJSON() : undefined,
      compatible,
      token,
      discard_token: credentials.discarded().length > 0,
      pairing_required: challenges.length > 0,
      // F1の`connection`は接続の状態。`disconnected`は、接続が閉じて次の呼び出しでつなぎ直す状態。
      connection: connection ?? (lastClient?.state === 'disconnected' ? 'closed' : lastClient?.state),
      matched_ids: matched,
      pending_ids: current.filter((call) => call.outcome === undefined).map((call) => call.id),
      unanswered_ids: current.filter((call) => call.outcome === 'closed').map((call) => call.id),
      completed_ids: current.filter((call) => call.outcome === 'response').map((call) => call.id),
      local_failures: localFailures,
      pairing_attempts: peer.received().filter((message) => message.method === 'auth.pairBegin').length,
    };
  } finally {
    received.restore();
    await Promise.all(clients.map((client) => client.close()));
    await peer.close();
  }
}

// stepsの後にclientが開いた接続で、tokenなしのhelloが来たことを確かめ、応答せずに閉じる。
async function closeFallbackHello(peer) {
  const message = await peer.unscriptedLine();
  assert.equal(message.method, 'hello');
  assert.equal(message.params.auth, undefined, 'tokenを捨てた後のhelloにtokenが載っている');
}

// clientがRPC層で受けたserverのerrorのreasonを、受けた順に記録する。
function observeRemoteErrors() {
  const reasons = [];
  const { request } = RpcConnection.prototype;
  RpcConnection.prototype.request = function (...args) {
    return request.apply(this, args).catch((error) => {
      if (error instanceof RemoteError) reasons.push(error.reason);
      throw error;
    });
  };
  return {
    reasons,
    restore() {
      RpcConnection.prototype.request = request;
    },
  };
}

function invoke(client, method, params) {
  switch (method) {
    case 'world.setBlock':
      return client.setBlock(params[0], params[1], params[2], params[3]);
    case 'world.getBlock':
      return client.getBlock(params[0], params[1], params[2]);
    default:
      throw new Error(`runnerが公開APIへ読み替えないmethod: ${method}`);
  }
}

function track(calls, id, kind) {
  const call = { id, kind, outcome: undefined };
  calls.push(call);
  return {
    settle(outcome) {
      call.outcome = outcome;
    },
  };
}

// memoryCredentialStoreを包み、runnerが中身と、捨てたtokenを観測できるようにする。
function recordingStore() {
  const inner = memoryCredentialStore();
  const discarded = [];
  let lastKey;
  let seeded;
  return {
    async load(key) {
      lastKey = key;
      if (seeded !== undefined) {
        await inner.save(key, seeded);
        seeded = undefined;
      }
      return inner.load(key);
    },
    save: (key, token) => {
      lastKey = key;
      return inner.save(key, token);
    },
    async delete(key) {
      lastKey = key;
      const token = await inner.load(key);
      if (token !== undefined) discarded.push(token);
      return inner.delete(key);
    },
    discarded: () => [...discarded],
    seed(token) {
      seeded = token;
    },
    async peek() {
      if (seeded !== undefined) return seeded;
      return lastKey === undefined ? undefined : inner.load(lastKey);
    },
  };
}

function checkExpected(suite, testCase, observed) {
  for (const [key, expected] of Object.entries(testCase.expected)) {
    const where = `${testCase.id}: expected.${key}`;
    switch (key) {
      case 'result':
        assert.deepEqual(observed.result, expected, where);
        if (suite === 'blocks') checkAgainstCatalog(observed.result, where);
        break;
      case 'error':
      case 'frames':
      case 'matched_ids':
      case 'ignored_ids':
      case 'pending_ids':
      case 'unanswered_ids':
      case 'completed_ids':
      case 'local_failures':
        assert.deepEqual(observed[key], expected, where);
        break;
      case 'reason':
      case 'compatible':
      case 'tail_hex':
      case 'token':
      case 'discard_token':
      case 'pairing_required':
      case 'connection':
      case 'pairing_attempts':
        assert.equal(observed[key], expected, where);
        break;
      default:
        assert.fail(`${where}: runnerが確かめないexpected`);
    }
  }
}

// BlockValueの出力は完全修飾IDとfull state（block-value-v22.jsonの/catalog/block）。
function checkAgainstCatalog(value, where) {
  const block = blockValues.catalog.block[value.block_id];
  assert.ok(block, `${where}: catalogに無いblock ${value.block_id}`);
  assert.deepEqual(Object.keys(value.state).sort(), Object.keys(block.states).sort(), `${where}: full stateでない`);
  for (const [property, propertyValue] of Object.entries(value.state)) {
    assert.ok(block.states[property].includes(propertyValue), `${where}: ${property}=${propertyValue}`);
  }
}

function resolvePointer(document, pointer) {
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((node, token) => (node === undefined ? undefined : node[token]), document);
}
