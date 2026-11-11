// 一般用途のClient API。接続、hello、world.setBlock／world.getBlock、close。
import { type CredentialKey, type CredentialStore, noCredentialStore } from './credentials.js';
import { McRemoteError, PairingExpiredError, ProtocolMismatchError, RemoteError } from './errors.js';
import {
  type BlockSpec,
  type BlockValue,
  type BuildContext,
  type ClientIdentity,
  DEFAULT_PORT,
  type HelloResult,
  PROTOCOL_VERSION,
  isCompatibleProtocol,
} from './protocol.js';
import { RpcConnection } from './rpc.js';

export interface ConnectOptions {
  host: string;
  /** 既定は25575。 */
  port?: number;
  /** helloと`auth.pairBegin`の`client`。省くと送らない。 */
  client?: ClientIdentity;
  /** helloの`build`。省くとserverの既定になる。 */
  build?: BuildContext;
  /** session tokenの置き場所。既定は何も保存しない。 */
  credentials?: CredentialStore;
  /** pair codeを人に見せる。渡したときだけ、必要ならpairingする。 */
  onPairing?: PairingHandler;
  /** 申告するprotocol。既定は`PROTOCOL_VERSION`。 */
  protocol?: string;
  /** pairingの時計（test用）。 */
  clock?: Clock;
}

export type PairingHandler = (challenge: PairingChallenge) => void | Promise<void>;

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** pairingの間、表示してよい情報。`pairing_id`は渡さない。 */
export interface PairingChallenge {
  /** wireの6桁の数字。 */
  readonly pairCode: string;
  /** 人に見せる形（`NNN-NNN`）。 */
  readonly displayCode: string;
  /** Minecraftの中で実行するcommand（`/mcremote pair NNN-NNN`）。 */
  readonly command: string;
  readonly expiresInSeconds: number;
}

// 該当のtokenを消してpairingへ戻るreason（DECISIONS 2026-08-30-03）。
const REJECTED_TOKEN_REASONS = new Set(['token_expired', 'token_revoked', 'token_not_found', 'token_invalid']);

// auth.pairPollの間隔（wire 6.5の非規範の目安、1〜2秒）。
const PAIR_POLL_INTERVAL_MS = 1500;

/**
 * 接続してhelloを通し、使える状態のclientを返す。
 *
 * まず保存済みのtokenでhelloを試す。`token_*`ではそのtokenを消してtokenなしのhelloからやり直し、
 * `auth_required`のときだけpairingする（wire 6.5）。pairingは一回の`connect()`につき一度だけ。
 * `onPairing`を渡さなければpairingせず、serverのerrorをそのまま投げる。
 */
export async function connect(options: ConnectOptions): Promise<MinecraftRemote> {
  const credentials = options.credentials ?? noCredentialStore();
  const key = credentialKey(options);
  let token = await credentials.load(key);
  let paired = false;
  for (;;) {
    try {
      return await openSession(options, token);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.reason === undefined) throw error;
      const tokenRejected = token !== undefined && REJECTED_TOKEN_REASONS.has(error.reason);
      if (tokenRejected) {
        await credentials.delete(key);
        token = undefined;
      }
      if (paired || !options.onPairing) throw error;
      if (tokenRejected) continue;
      if (error.reason !== 'auth_required') throw error;
      token = await pair(options, options.onPairing);
      paired = true;
      await credentials.save(key, token);
    }
  }
}

// pairingは専用の接続で行い、終わったら閉じる（helloは新しい接続で送る）。
async function pair(options: ConnectOptions, onPairing: PairingHandler): Promise<string> {
  const clock = options.clock ?? systemClock;
  const connection = await RpcConnection.open(options.host, options.port ?? DEFAULT_PORT);
  try {
    const begin = await connection.request('auth.pairBegin', {
      token_type: 'session',
      ...(options.client && { client: options.client }),
    });
    if (!isPairBeginResult(begin)) throw new McRemoteError('auth.pairBegin result is malformed');
    const deadline = clock.now() + begin.expires_in * 1000;
    const displayCode = /^\d{6}$/.test(begin.pair_code)
      ? `${begin.pair_code.slice(0, 3)}-${begin.pair_code.slice(3)}`
      : begin.pair_code;
    await onPairing({
      pairCode: begin.pair_code,
      displayCode,
      command: `/mcremote pair ${displayCode}`,
      expiresInSeconds: begin.expires_in,
    });
    for (;;) {
      await clock.sleep(PAIR_POLL_INTERVAL_MS);
      const poll = await connection.request('auth.pairPoll', { pairing_id: begin.pairing_id });
      const status = (poll as { status?: unknown } | null)?.status;
      if (status === 'ok' && typeof (poll as { token?: unknown }).token === 'string') {
        return (poll as { token: string }).token;
      }
      if (status !== 'pending') throw new McRemoteError('auth.pairPoll result is malformed');
      if (clock.now() >= deadline) throw new PairingExpiredError();
    }
  } finally {
    await connection.close();
  }
}

async function openSession(options: ConnectOptions, token: string | undefined): Promise<MinecraftRemote> {
  const connection = await RpcConnection.open(options.host, options.port ?? DEFAULT_PORT);
  const protocol = options.protocol ?? PROTOCOL_VERSION;
  try {
    const result = await connection.request('hello', {
      protocol,
      ...(options.client && { client: options.client }),
      ...(token !== undefined && { auth: { token } }),
      ...(options.build && { build: options.build }),
    });
    if (!isHelloResult(result)) throw new McRemoteError('hello result is malformed');
    if (!isCompatibleProtocol(protocol, result.protocol)) {
      throw new ProtocolMismatchError({ source: 'client', server: result.protocol, clientRequires: protocol });
    }
    return new MinecraftRemote(connection, result);
  } catch (error) {
    await connection.close();
    if (error instanceof RemoteError && error.reason === 'protocol_mismatch') {
      throw new ProtocolMismatchError({
        source: 'server',
        server: stringField(error.data, 'server'),
        clientRequires: stringField(error.data, 'client_requires'),
        cause: error,
      });
    }
    throw error;
  }
}

export class MinecraftRemote {
  readonly #connection: RpcConnection;
  /** helloの成功result。 */
  readonly hello: HelloResult;

  /** @internal `connect()`で作る。 */
  constructor(connection: RpcConnection, hello: HelloResult) {
    this.#connection = connection;
    this.hello = hello;
  }

  get state(): 'open' | 'closed' {
    return this.#connection.state;
  }

  /** 接続が閉じたときにresolveする。 */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  /**
   * 1ブロックを置く。座標はbuild originからの相対。文字列はstateを指定しないblock IDとして送る。
   * 値の検査はserverが行い、拒否はRemoteError（`unknown_block`、`invalid_property_value`など）になる。
   */
  async setBlock(x: number, y: number, z: number, block: BlockSpec | string): Promise<void> {
    const spec = typeof block === 'string' ? { block_id: block, state: {} } : block;
    await this.#connection.request('world.setBlock', [x, y, z, spec]);
  }

  /** 1ブロックを読む。block_idは完全修飾、stateはfull state。 */
  async getBlock(x: number, y: number, z: number): Promise<BlockValue> {
    return (await this.#connection.request('world.getBlock', [x, y, z])) as BlockValue;
  }

  /** このAPIがまだ投影していないmethodを、そのまま呼ぶ。 */
  call(method: string, params: unknown[] | Record<string, unknown>): Promise<unknown> {
    return this.#connection.request(method, params);
  }

  close(): Promise<void> {
    return this.#connection.close();
  }
}

function credentialKey(options: ConnectOptions): CredentialKey {
  return {
    application: options.client?.name ?? '',
    credentialType: 'session',
    transport: 'tcp',
    target: `${options.host}:${options.port ?? DEFAULT_PORT}`,
  };
}

function isPairBeginResult(
  result: unknown,
): result is { pairing_id: string; pair_code: string; expires_in: number } {
  const begin = result as Record<string, unknown> | null;
  return (
    typeof begin === 'object' &&
    begin !== null &&
    typeof begin.pairing_id === 'string' &&
    typeof begin.pair_code === 'string' &&
    typeof begin.expires_in === 'number'
  );
}

function isHelloResult(result: unknown): result is HelloResult {
  return typeof result === 'object' && result !== null && typeof (result as HelloResult).protocol === 'string';
}

function stringField(data: Readonly<Record<string, unknown>> | undefined, name: string): string | undefined {
  const value = data?.[name];
  return typeof value === 'string' ? value : undefined;
}
