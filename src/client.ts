// 一般用途のClient API。接続、hello、world.setBlock／world.getBlock、close、切れた後のつなぎ直し。
import { type CredentialKey, type CredentialStore, noCredentialStore } from './credentials.js';
import {
  ConnectionError,
  McRemoteError,
  NotSentError,
  PairingExpiredError,
  ProtocolMismatchError,
  RemoteError,
} from './errors.js';
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
import { RpcConnection, type RpcConnectionOptions } from './rpc.js';

export interface ConnectOptions {
  host: string;
  /** 既定は25575。 */
  port?: number;
  /** helloと`auth.pairBegin`の`client`。省くと送らない。 */
  client?: ClientIdentity;
  /** 最初のhelloの`build`。省くとserverの既定になる。 */
  build?: BuildContext;
  /** session tokenの置き場所。既定は何も保存しない。 */
  credentials?: CredentialStore;
  /** pair codeを人に見せる。渡したときだけ、`connect()`の中で必要ならpairingする。つなぎ直しではpairingしない。 */
  onPairing?: PairingHandler;
  /** 申告するprotocol。既定は`PROTOCOL_VERSION`。 */
  protocol?: string;
  /**
   * 応答待ちがある間、その接続で最後に受信してから待つ長さ（ms）。超えたら応答待ちを`CompletionUnknownError`にして、
   * 接続を回収する。既定は15分。`Infinity`なら回収しない。呼び出しごとに延ばせる（`CallOptions`）。
   */
  responseTimeout?: number;
  /** TCPのkeepaliveを始めるまでの静かな時間（ms）。切れた接続を見つける。`false`なら使わない。既定は30秒。 */
  keepAliveDelay?: number | false;
  /** 切れた後の次の呼び出しで、自動でつなぎ直す。既定は有効。`false`で無効。 */
  reconnect?: boolean | ReconnectOptions;
  /** つなぎ直したことを知らせる。 */
  onReconnect?: (event: ReconnectEvent) => void;
  /** pairingとつなぎ直しの時計（test用）。 */
  clock?: Clock;
}

/** つなぎ直しの間隔（ms）。間隔はばらつかせながら倍にしていき、`giveUpAfter`を超える前に諦める。 */
export interface ReconnectOptions {
  /** 既定は500。 */
  initialDelay?: number;
  /** 既定は30秒。 */
  maxDelay?: number;
  /** 既定は5分。 */
  giveUpAfter?: number;
}

/** つなぎ直した後のhello。前の接続で得たentity handleやevent cursorは、新しい接続では使えない。 */
export interface ReconnectEvent {
  readonly previous: HelloResult;
  readonly hello: HelloResult;
  readonly serverChanged: boolean;
  readonly sessionChanged: boolean;
  readonly catalogHashChanged: boolean;
}

export interface CallOptions {
  /** この応答を待つ間だけ、`responseTimeout`を延ばす（ms）。短くはしない。 */
  responseTimeout?: number;
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

// 値は実測で決める（DECISIONS 2026-11-11-01③）。keepaliveで切れたと分かるまで（Linuxの既定で約12分）より長くする。
const DEFAULT_RESPONSE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_KEEPALIVE_DELAY_MS = 30_000;
const DEFAULT_RECONNECT: Required<ReconnectOptions> = { initialDelay: 500, maxDelay: 30_000, giveUpAfter: 5 * 60_000 };

// 成功resultが今のbuild contextを返すsetter（wire 5.1）。
const BUILD_SETTERS = new Set(['build.setDimension', 'build.setOrigin']);

interface Session {
  connection: RpcConnection;
  hello: HelloResult;
}

/**
 * 接続してhelloを通し、使える状態のclientを返す。
 *
 * まず保存済みのtokenでhelloを試す。`token_*`ではそのtokenを消してtokenなしのhelloからやり直し、
 * `auth_required`のときだけpairingする（wire 6.5）。pairingは一回の`connect()`につき一度だけ。
 * `onPairing`を渡さなければpairingせず、serverのerrorをそのまま投げる。
 */
export async function connect(options: ConnectOptions): Promise<MinecraftRemote> {
  reconnectPolicy(options.reconnect);
  const session = await establish(options, options.build, options.onPairing);
  return new MinecraftRemote(options, session);
}

async function establish(
  options: ConnectOptions,
  build: BuildContext | undefined,
  onPairing: PairingHandler | undefined,
): Promise<Session> {
  const credentials = options.credentials ?? noCredentialStore();
  const key = credentialKey(options);
  let token = await credentials.load(key);
  let paired = false;
  for (;;) {
    try {
      return await openSession(options, token, build);
    } catch (error) {
      if (!(error instanceof RemoteError) || error.reason === undefined) throw error;
      if (token !== undefined && REJECTED_TOKEN_REASONS.has(error.reason)) {
        await credentials.delete(key);
        token = undefined;
        // pairingしなくても、tokenなしのhelloへ戻る（DECISIONS 2026-11-11-01⑦）。
        if (!paired) continue;
        throw error;
      }
      if (error.reason !== 'auth_required' || paired || !onPairing) throw error;
      token = await pair(options, onPairing);
      paired = true;
      await credentials.save(key, token);
    }
  }
}

// pairingは専用の接続で行い、終わったら閉じる（helloは新しい接続で送る）。
async function pair(options: ConnectOptions, onPairing: PairingHandler): Promise<string> {
  const clock = options.clock ?? systemClock;
  const connection = await RpcConnection.open(options.host, options.port ?? DEFAULT_PORT, connectionOptions(options));
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

async function openSession(
  options: ConnectOptions,
  token: string | undefined,
  build: BuildContext | undefined,
): Promise<Session> {
  const connection = await RpcConnection.open(options.host, options.port ?? DEFAULT_PORT, connectionOptions(options));
  const protocol = options.protocol ?? PROTOCOL_VERSION;
  try {
    const hello = await connection.request('hello', {
      protocol,
      ...(options.client && { client: options.client }),
      ...(token !== undefined && { auth: { token } }),
      ...(build && { build }),
    });
    if (!isHelloResult(hello)) throw new McRemoteError('hello result is malformed');
    // 互換でなければ、次のrequestを送らずに閉じる（DECISIONS 2026-11-12-01）。
    if (!isCompatibleProtocol(protocol, hello.protocol)) {
      throw new ProtocolMismatchError({ source: 'client', server: hello.protocol, clientRequires: protocol });
    }
    return { connection, hello };
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
  readonly #options: ConnectOptions;
  #connection: RpcConnection;
  #hello: HelloResult;
  // 最後に成功を確かめたbuild context。つなぎ直したhelloの`build`で戻す（DECISIONS 2026-11-11-01⑤）。
  #build: BuildContext;
  #reconnecting: Promise<RpcConnection> | undefined;
  #closedByApplication = false;

  /** @internal `connect()`で作る。 */
  constructor(options: ConnectOptions, session: Session) {
    this.#options = options;
    this.#connection = session.connection;
    this.#hello = session.hello;
    this.#build = buildOf(session.hello);
  }

  /** 今の接続のhelloの成功result。つなぎ直すと変わる。 */
  get hello(): HelloResult {
    return this.#hello;
  }

  /**
   * `open`：つながっている。`disconnected`：切れていて、次の呼び出しでつなぎ直す。
   * `closed`：applicationが閉じたか、つなぎ直しが無効で切れた。
   */
  get state(): 'open' | 'disconnected' | 'closed' {
    if (this.#closedByApplication) return 'closed';
    if (this.#connection.state === 'open') return 'open';
    return reconnectPolicy(this.#options.reconnect) ? 'disconnected' : 'closed';
  }

  /** 今の接続が閉じたときにresolveする。 */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  /**
   * 1ブロックを置く。座標はbuild originからの相対。文字列はstateを指定しないblock IDとして送る。
   * 値の検査はserverが行い、拒否はRemoteError（`unknown_block`、`invalid_property_value`など）になる。
   */
  async setBlock(x: number, y: number, z: number, block: BlockSpec | string, options?: CallOptions): Promise<void> {
    const spec = typeof block === 'string' ? { block_id: block, state: {} } : block;
    await this.#request('world.setBlock', [x, y, z, spec], options);
  }

  /** 1ブロックを読む。block_idは完全修飾、stateはfull state。 */
  async getBlock(x: number, y: number, z: number, options?: CallOptions): Promise<BlockValue> {
    return (await this.#request('world.getBlock', [x, y, z], options)) as BlockValue;
  }

  /** このAPIがまだ投影していないmethodを、そのまま呼ぶ。 */
  async call(method: string, params: unknown[] | Record<string, unknown>, options?: CallOptions): Promise<unknown> {
    const result = await this.#request(method, params, options);
    if (BUILD_SETTERS.has(method) && isBuildResult(result)) this.#build = buildOf(result);
    return result;
  }

  /** 接続を閉じる。この後はつなぎ直さない。つなぎ直しの途中なら、つながった接続はそのまま閉じる。 */
  async close(): Promise<void> {
    this.#closedByApplication = true;
    await this.#connection.close();
  }

  async #request(method: string, params: unknown, options: CallOptions | undefined): Promise<unknown> {
    const connection = await this.#ready(method);
    return connection.request(method, params, options);
  }

  // 切れていたら、この呼び出しでつなぎ直す。同時の呼び出しは同じつなぎ直しを待つ（同⑤E）。
  async #ready(method: string): Promise<RpcConnection> {
    if (this.#closedByApplication) throw new NotSentError(`the client is closed; ${method} was not sent`);
    if (this.#connection.state === 'open') return this.#connection;
    const policy = reconnectPolicy(this.#options.reconnect);
    if (!policy) throw new NotSentError(`the connection is closed; ${method} was not sent`);
    this.#reconnecting ??= this.#reconnect(policy).finally(() => {
      this.#reconnecting = undefined;
    });
    try {
      return await this.#reconnecting;
    } catch (error) {
      if (error instanceof NotSentError) throw error;
      throw new NotSentError(`could not reconnect; ${method} was not sent`, { cause: error });
    }
  }

  // 保存したtokenで新しいhelloから始める。pairingは進めない（同⑤D）。版の互換判定はopenSessionでやり直す（同⑤C）。
  // 接続できないときだけ、間隔をばらつかせながら延ばして試し直す（同⑤F）。
  async #reconnect(policy: Required<ReconnectOptions>): Promise<RpcConnection> {
    const clock = this.#options.clock ?? systemClock;
    const started = clock.now();
    let delay = policy.initialDelay;
    for (;;) {
      let session: Session;
      try {
        session = await establish(this.#options, this.#build, undefined);
      } catch (error) {
        const wait = delay * (0.5 + Math.random() / 2);
        const retry = error instanceof ConnectionError && clock.now() - started + wait <= policy.giveUpAfter;
        if (!retry || this.#closedByApplication) throw error;
        await clock.sleep(wait);
        delay = Math.min(delay * 2, policy.maxDelay);
        continue;
      }
      if (this.#closedByApplication) {
        await session.connection.close();
        throw new NotSentError('the client was closed while reconnecting');
      }
      const previous = this.#hello;
      this.#connection = session.connection;
      this.#hello = session.hello;
      this.#build = buildOf(session.hello);
      this.#options.onReconnect?.({
        previous,
        hello: session.hello,
        serverChanged: previous.server !== session.hello.server,
        sessionChanged: previous.session !== session.hello.session,
        catalogHashChanged: previous.catalogHash !== session.hello.catalogHash,
      });
      return session.connection;
    }
  }
}

function reconnectPolicy(reconnect: ConnectOptions['reconnect']): Required<ReconnectOptions> | undefined {
  if (reconnect === false) return undefined;
  const policy = { ...DEFAULT_RECONNECT, ...(typeof reconnect === 'object' ? reconnect : {}) };
  for (const [name, value] of Object.entries(policy)) {
    if (!(value > 0)) throw new RangeError(`reconnect.${name} must be a positive number of milliseconds`);
  }
  return policy;
}

function connectionOptions(options: ConnectOptions): RpcConnectionOptions {
  return {
    responseTimeout: options.responseTimeout ?? DEFAULT_RESPONSE_TIMEOUT_MS,
    keepAliveDelay: options.keepAliveDelay ?? DEFAULT_KEEPALIVE_DELAY_MS,
  };
}

function credentialKey(options: ConnectOptions): CredentialKey {
  return {
    application: options.client?.name ?? '',
    credentialType: 'session',
    transport: 'tcp',
    target: `${options.host}:${options.port ?? DEFAULT_PORT}`,
  };
}

function buildOf(context: { dimension: string; origin: BuildContext['origin'] }): BuildContext {
  return { dimension: context.dimension, origin: context.origin };
}

function isBuildResult(result: unknown): result is BuildContext {
  const build = result as Record<string, unknown> | null;
  return (
    typeof build === 'object' &&
    build !== null &&
    typeof build.dimension === 'string' &&
    Array.isArray(build.origin) &&
    build.origin.length === 3 &&
    build.origin.every((value) => typeof value === 'number')
  );
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
