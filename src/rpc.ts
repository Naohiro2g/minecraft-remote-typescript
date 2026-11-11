// Node.jsのTCPの上のJSON-RPC 2.0（wire 2、3）。1接続ごとにidを1から採番し、応答をidで対応させる。
import net from 'node:net';

import { CompletionUnknownError, ConnectionError, NotSentError, RemoteError, type RemoteErrorObject } from './errors.js';
import { LineDecoder, encodeFrame } from './framing.js';

/** 受け取って捨てた行の分類。 */
export type DiscardReason = 'not_json' | 'not_response' | 'unknown_id';

export interface RpcConnectionOptions {
  /** 捨てた行を観測する（test、診断用）。 */
  onDiscard?: (frame: unknown, why: DiscardReason) => void;
  /** 応答待ちがある間、最後に受信してから待つ長さ（ms）。`Infinity`なら回収しない。既定は回収しない。 */
  responseTimeout?: number;
  /** TCPのkeepaliveを始めるまでの静かな時間（ms）。`false`なら使わない。既定は使わない。 */
  keepAliveDelay?: number | false;
}

export interface RequestOptions {
  /** この応答を待つ間だけ、接続のresponseTimeoutを延ばす（ms）。短くはしない。 */
  responseTimeout?: number;
}

interface Pending {
  method: string;
  responseTimeout: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class RpcConnection {
  readonly #socket: net.Socket;
  readonly #decoder: LineDecoder;
  readonly #pending = new Map<number, Pending>();
  readonly #onDiscard: RpcConnectionOptions['onDiscard'];
  readonly #responseTimeout: number;
  readonly #closed: Promise<void>;
  #nextId = 1;
  #state: 'open' | 'closed' = 'open';
  #failure: Error | undefined;
  #closeReason: string | undefined;
  // 応答待ちが始まった時刻か、最後に受信した時刻の遅い方。
  #lastProgress = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  private constructor(socket: net.Socket, options: RpcConnectionOptions | undefined) {
    this.#socket = socket;
    this.#onDiscard = options?.onDiscard;
    this.#responseTimeout = options?.responseTimeout ?? Infinity;
    this.#decoder = new LineDecoder({ onInvalidLine: (line) => this.#onDiscard?.(line, 'not_json') });
    socket.on('data', (chunk: Buffer) => {
      this.#lastProgress = performance.now();
      for (const frame of this.#decoder.push(chunk)) this.#receive(frame);
      if (this.#pending.size === 0) this.#disarm();
    });
    socket.on('error', (error) => {
      this.#failure ??= error;
    });
    // 相手のEOFの後は応答を受け取れない。LFの無い末尾は応答にしない。
    socket.on('end', () => this.#finish());
    this.#closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.#finish();
        resolve();
      });
    });
  }

  /** 接続する。接続できなければConnectionError。 */
  static open(host: string, port: number, options?: RpcConnectionOptions): Promise<RpcConnection> {
    checkTimeout('responseTimeout', options?.responseTimeout);
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port });
      const fail = (error: Error) => {
        socket.destroy();
        // 接続先は通常のlogへ出さない。詳細はcauseに残る。
        reject(new ConnectionError('could not connect to the server', { cause: error }));
      };
      socket.once('error', fail);
      socket.once('connect', () => {
        socket.off('error', fail);
        const keepAliveDelay = options?.keepAliveDelay ?? false;
        if (keepAliveDelay !== false) socket.setKeepAlive(true, keepAliveDelay);
        resolve(new RpcConnection(socket, options));
      });
    });
  }

  get state(): 'open' | 'closed' {
    return this.#state;
  }

  /** 接続が閉じたときにresolveする。閉じた理由は問わない。 */
  get closed(): Promise<void> {
    return this.#closed;
  }

  /** 応答を待っているrequestのid。 */
  get pendingIds(): number[] {
    return [...this.#pending.keys()];
  }

  /**
   * id付きrequestを送り、resultを返す。serverのerrorはRemoteError。
   * 閉じていて送らなかったらNotSentError、送った後に閉じたらCompletionUnknownError。
   */
  request(method: string, params: unknown, options?: RequestOptions): Promise<unknown> {
    if (this.#state === 'closed') {
      return Promise.reject(new NotSentError(`connection is closed; ${method} was not sent`));
    }
    checkTimeout('responseTimeout', options?.responseTimeout);
    const id = this.#nextId++;
    if (this.#pending.size === 0) this.#lastProgress = performance.now();
    return new Promise((resolve, reject) => {
      const responseTimeout = Math.max(this.#responseTimeout, options?.responseTimeout ?? 0);
      this.#pending.set(id, { method, responseTimeout, resolve, reject });
      this.#socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
      this.#arm();
    });
  }

  /** 接続を閉じる。応答を待っていたrequestはCompletionUnknownErrorになる。 */
  close(): Promise<void> {
    if (this.#state === 'open' && !this.#socket.destroyed) {
      this.#socket.end(() => this.#socket.destroy());
    }
    return this.#closed;
  }

  #receive(frame: unknown): void {
    if (!isResponse(frame)) {
      this.#onDiscard?.(frame, 'not_response');
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (!pending) {
      // 待ち先の無い応答は捨てる（wire 2）。
      this.#onDiscard?.(frame, 'unknown_id');
      return;
    }
    this.#pending.delete(frame.id);
    if ('error' in frame) {
      pending.reject(new RemoteError(pending.method, frame.error));
    } else {
      pending.resolve(frame.result);
    }
  }

  // 最後の受信から、応答待ちの中で最も長いresponseTimeoutを過ぎたら回収する（DECISIONS 2026-11-11-01③）。
  // 要求ごとの期限にしないのは、FIFOの前に並んだ処理の時間が入るから。
  #arm(): void {
    this.#disarm();
    if (this.#state === 'closed' || this.#pending.size === 0) return;
    const limit = Math.max(...[...this.#pending.values()].map((pending) => pending.responseTimeout));
    if (!Number.isFinite(limit)) return;
    const remaining = this.#lastProgress + limit - performance.now();
    if (remaining <= 0) {
      this.#closeReason = `no data was received for ${limit} ms`;
      this.#finish();
      this.#socket.destroy();
      return;
    }
    // setTimeoutは約24.8日を超える値をすぐに発火させる。
    this.#timer = setTimeout(() => this.#arm(), Math.min(remaining, MAX_TIMER_MS));
    this.#timer.unref();
  }

  #disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  // 閉じたら、応答待ちをすべてlocalな「完了不明」の失敗にする。serverのerrorにはしない（同②）。
  #finish(): void {
    this.#state = 'closed';
    this.#disarm();
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      const why = this.#closeReason ?? 'connection closed';
      pending.reject(
        new CompletionUnknownError(`${why} before the response to ${pending.method}; it may or may not have run`, {
          cause: this.#failure,
        }),
      );
    }
  }
}

const MAX_TIMER_MS = 2 ** 31 - 1;

function checkTimeout(name: string, value: number | undefined): void {
  if (value !== undefined && !(value > 0)) throw new RangeError(`${name} must be a positive number of milliseconds`);
}

type Response = { id: number; result: unknown } | { id: number; error: RemoteErrorObject };

function isResponse(frame: unknown): frame is Response {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) return false;
  const message = frame as Record<string, unknown>;
  if (message.jsonrpc !== '2.0' || !Number.isInteger(message.id) || 'method' in message) return false;
  if ('result' in message) return !('error' in message);
  const error = message.error;
  return typeof error === 'object' && error !== null && typeof (error as RemoteErrorObject).code === 'number';
}
