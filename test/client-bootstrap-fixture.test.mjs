// 共有fixture F1（client bootstrap、protocol 23.2.1）の全caseを、このclientで確かめる。
// 取得元とdigestは test/fixtures/protocol/SOURCE_ja.md。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { setImmediate, setTimeout } from 'node:timers';
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
  'client-bootstrap-hello-v23.2.1.json': [26046, 'caf24ad5382e411ba54172b05d6020fc59fc429dc0251ff28db3908b4189784e'],
  'client-bootstrap-pairing-v23.2.1.json': [45943, '19230b310c7482adc740095d5604110937ebaa7803a0fed4c294083a9e63a460'],
  'client-bootstrap-blocks-v23.2.1.json': [45945, '664babdf3131a74e4aaf6d9e5dfb5e4cfc6e197df0a0d48142688820f1be813d'],
  'client-bootstrap-errors-v23.2.1.json': [9179, 'c458d3ffbae846cfb33c032eba14d8f0005c6a1fbe871290b53fcfec8ec41aaa'],
  'client-bootstrap-close-v23.2.1.json': [20879, '2abb6f48942e1dc7bc42014ba016c3d08a6632c59445c048b008a4c411ea1e30'],
  'client-bootstrap-operations-v23.2.1.json': [66335, '8309f5847ad69aa2d82fcbcb1726918c3a69ba875e04e8f38678352b06b7f7a1'],
  'client-bootstrap-v1.schema.json': [11521, '970dd68999edc14a4dcc2b67ab2f712e830b7841b2ec4548fee66af117fd281b'],
  'client-bootstrap-v2.schema.json': [19468, '8ae1c7313d01fa0fa24f4f2079ba453129dc16b678342df6f7ef66b9255d1381'],
  'block-value-v22.json': [3217, 'e8e108d59c40751d67a432543d75cb4bf9146ef9781721012085c80545b854f3'],
  LICENSE: [1070, 'aa329a0bafc839b95124306141db13a381de45818bf629e983c44ea55ab5a7fb'],
};

// v1の6 file。v2のoperationsは client-bootstrap-operations.test.mjs が読む。
const SUITE_CASES = { framing: 7, hello: 12, pairing: 12, blocks: 12, errors: 3, close: 8 };

// 公開APIに無い操作（hello前のenvelope、発行paramsの拒否、別のpairing_id）を送るcaseは、RPC層で再生する。
const RAW_CASES = new Set(['F1-FR-07', 'F1-AU-03', 'F1-AU-04']);

// stepsが接続試行の途中で終わるcase（toolingのpackages/protocol/README.md「AU-07／AU-12の観測の終わり」）。
// AU-07はtokenを捨てたところ、AU-12は応答の前に切れたpollが完了不明になったところで終わる。clientはその後も
// tokenなしのhello（DECISIONS 2026-11-11-01⑦）や次のpoll（同2026-11-12-05）へ進むが、caseはその接続を書いていない。
// runnerはstepsの後の接続を断り、stepsの範囲を観測する。`reason`はstepsの中でclientが受けたerrorから読み、
// 接続の欄はstepsの最後の接続をRPC層で見る（pairingのpollは公開APIの呼び出しではない）。
const ENDS_INSIDE_ATTEMPT = new Set(['F1-AU-07', 'F1-AU-12']);

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

test('fixtureがschemaの形に沿い、caseが54件そろう', () => {
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
  assert.equal(ids.size, 54);
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
    observed = await runDialog(testCase.steps, { endsInsideAttempt: ENDS_INSIDE_ATTEMPT.has(testCase.id) });
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

const CLIENT_OPS = new Set(['client_send', 'client_close']);

// fixtureの対話を、公開APIの操作の列に読み替える。pairingの内側の接続とmessage、認証reasonの後のhelloは、
// connect()が自分で行う。
// 次のstepもclientの送信かcloseなら、clientは応答を待たずに続ける（`overlap`）。
function planDialog(steps) {
  const actions = [];
  let inPairing = false;
  let pairedHelloSent = false;
  let helloSent = false;
  let sameAttempt = false;
  for (const [index, step] of steps.entries()) {
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
        actions.push({ kind: 'call', id, method, params, overlap: CLIENT_OPS.has(steps[index + 1]?.op) });
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

async function runDialog(steps, { endsInsideAttempt = false } = {}) {
  const clock = new FakeClock();
  const peer = await startPeer(steps, clock);
  const rpc = observeRpc();
  const credentials = recordingStore();
  const pairs = steps.some((step) => step.message?.method === 'auth.pairBegin');
  const challenges = [];
  const clients = [];
  const calls = [];
  const matched = [];
  const localFailures = [];
  const overlapping = [];
  let lastClient;
  let lastResult;
  let lastError;
  let compatible;
  let connection;

  // peerが先に失敗したら接続を閉じ、応答待ちのclientを解く。
  const peerDone = (endsInsideAttempt ? peer.done.then(() => peer.refuse()) : peer.done).catch(async (error) => {
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
        // 互換判定で失敗したconnect()は、clientが自分で閉じている。runnerは閉じない（F1-HE-11、12）。
        // 重ねた呼び出しがrequestを書き終えてから閉じる（F1-CL-08）。
        await new Promise((resolve) => setImmediate(resolve));
        if (lastClient) await lastClient.close();
      } else {
        const result = runCall(action);
        if (action.overlap) {
          overlapping.push(result);
        } else {
          await result;
        }
      }
    }
    await Promise.all(overlapping);
  };

  const runCall = async (action) => {
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
      reason: endsInsideAttempt ? rpc.reasons.at(-1) : lastError?.reason,
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
      application_failure:
        lastError instanceof ProtocolMismatchError && lastError.source === 'client'
          ? { source: 'client', kind: 'incompatible_protocol' }
          : undefined,
      ...(endsInsideAttempt && observeScriptedConnection(rpc, steps)),
    };
  } finally {
    rpc.restore();
    await Promise.all(clients.map((client) => client.close()));
    await peer.close();
  }
}

// clientがRPC層で開いた接続と、各接続で送ったrequestの結末を記録する。serverのerrorのreasonは受けた順に残す。
function observeRpc() {
  const reasons = [];
  const opened = [];
  const sent = new Map();
  const { open } = RpcConnection;
  const { request } = RpcConnection.prototype;
  RpcConnection.open = async function (...args) {
    const connection = await open.apply(this, args);
    opened.push(connection);
    sent.set(connection, []);
    return connection;
  };
  RpcConnection.prototype.request = function (...args) {
    const before = new Set(this.pendingIds);
    const promise = request.apply(this, args);
    // 送ったrequestは、送った時点で応答待ちに入る。閉じていて送らなかったものは記録しない。
    const id = this.pendingIds.find((pendingId) => !before.has(pendingId));
    const entry = { id, outcome: undefined };
    if (id !== undefined) sent.get(this)?.push(entry);
    return promise.then(
      (result) => {
        entry.outcome = 'response';
        return result;
      },
      (error) => {
        if (error instanceof RemoteError) {
          entry.outcome = 'response';
          reasons.push(error.reason);
        } else if (error instanceof CompletionUnknownError) {
          entry.outcome = 'completion_unknown';
        }
        throw error;
      },
    );
  };
  return {
    reasons,
    opened,
    sent,
    restore() {
      RpcConnection.open = open;
      RpcConnection.prototype.request = request;
    },
  };
}

// stepsの最後の接続の状態と、その接続で送ったrequestの結末。
function observeScriptedConnection(rpc, steps) {
  const connection = rpc.opened[steps.filter((step) => step.op === 'connect').length - 1];
  const requests = rpc.sent.get(connection);
  const lost = requests.filter((request) => request.outcome === 'completion_unknown').map((request) => request.id);
  return {
    connection: connection.state,
    pending_ids: connection.pendingIds,
    unanswered_ids: lost,
    completed_ids: requests.filter((request) => request.outcome === 'response').map((request) => request.id),
    local_failures: lost.map((id) => ({ id, outcome: 'completion_unknown' })),
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
      case 'application_failure':
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
