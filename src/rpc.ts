// Node.jsのTCPの上のJSON-RPC 2.0（wire 2、3）。1接続ごとにidを1から採番し、応答をidで対応させる。
import net from 'node:net';

import { ConnectionError, RemoteError, type RemoteErrorObject } from './errors.js';
import { LineDecoder, encodeFrame } from './framing.js';

/** 受け取って捨てた行の分類。 */
export type DiscardReason = 'not_json' | 'not_response' | 'unknown_id';

export interface RpcConnectionOptions {
  /** 捨てた行を観測する（test、診断用）。 */
  onDiscard?: (frame: unknown, why: DiscardReason) => void;
}

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class RpcConnection {
  readonly #socket: net.Socket;
  readonly #decoder: LineDecoder;
  readonly #pending = new Map<number, Pending>();
  readonly #onDiscard: RpcConnectionOptions['onDiscard'];
  readonly #closed: Promise<void>;
  #nextId = 1;
  #state: 'open' | 'closed' = 'open';
  #failure: Error | undefined;

  private constructor(socket: net.Socket, options: RpcConnectionOptions | undefined) {
    this.#socket = socket;
    this.#onDiscard = options?.onDiscard;
    this.#decoder = new LineDecoder({ onInvalidLine: (line) => this.#onDiscard?.(line, 'not_json') });
    socket.on('data', (chunk: Buffer) => {
      for (const frame of this.#decoder.push(chunk)) this.#receive(frame);
    });
    socket.on('error', (error) => {
      this.#failure ??= error;
    });
    this.#closed = new Promise((resolve) => {
      socket.once('close', () => {
        this.#finish();
        resolve();
      });
    });
  }

  /** 接続する。接続できなければConnectionError。 */
  static open(host: string, port: number, options?: RpcConnectionOptions): Promise<RpcConnection> {
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

  /** id付きrequestを送り、resultを返す。serverのerrorはRemoteError。 */
  request(method: string, params: unknown): Promise<unknown> {
    if (this.#state === 'closed') {
      return Promise.reject(new ConnectionError(`connection is closed; ${method} was not sent`));
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { method, resolve, reject });
      this.#socket.write(encodeFrame({ jsonrpc: '2.0', id, method, params }));
    });
  }

  /** 接続を閉じる。応答を待っていたrequestはConnectionErrorになる。 */
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

  // 応答待ちを解かないとhangする。LFの無い末尾は応答にせず捨てる。
  // 切断時の扱いと例外の型はknowledgeのE2（U2）で決まるまでの暫定で、決まったら合わせる。
  #finish(): void {
    this.#state = 'closed';
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(
        new ConnectionError(`connection closed before the response to ${pending.method}`, { cause: this.#failure }),
      );
    }
  }
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
