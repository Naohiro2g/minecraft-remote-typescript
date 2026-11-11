// clientが投げるerror。分岐には`reason`を使う（wire 7.3）。codeでは分けない。

/** このlibraryが投げるerrorの基底。`reason`はserverまたは契約が決めた分類で、無いものは捏造しない。 */
export class McRemoteError extends Error {
  override name = 'McRemoteError';
  readonly reason: string | undefined;

  constructor(message: string, options?: { reason?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.reason = options?.reason;
  }
}

export interface RemoteErrorObject {
  code: number;
  message: string;
  data?: Record<string, unknown>;
}

/** serverが返したJSON-RPCのerror。code、message、dataを受け取ったまま保つ。 */
export class RemoteError extends McRemoteError {
  override name = 'RemoteError';
  readonly method: string;
  readonly code: number;
  readonly data: Readonly<Record<string, unknown>> | undefined;

  constructor(method: string, error: RemoteErrorObject) {
    const reason = typeof error.data?.reason === 'string' ? error.data.reason : undefined;
    super(error.message, { reason });
    this.method = method;
    this.code = error.code;
    this.data = error.data;
  }

  toJSON(): RemoteErrorObject {
    return { code: this.code, message: this.message, ...(this.data !== undefined && { data: this.data }) };
  }
}

/**
 * protocolの不一致（versioning 8）。serverが拒んだとき（`source: 'server'`、causeにRemoteError）と、
 * helloの応答の版をclientが満たさないと判定したとき（`source: 'client'`）がある。
 */
export class ProtocolMismatchError extends McRemoteError {
  override name = 'ProtocolMismatchError';
  readonly source: 'server' | 'client';
  /** serverのprotocol。 */
  readonly server: string | undefined;
  /** clientがhelloで申告したprotocol。 */
  readonly clientRequires: string | undefined;

  constructor(options: {
    source: 'server' | 'client';
    server: string | undefined;
    clientRequires: string | undefined;
    cause?: RemoteError;
  }) {
    const message =
      options.cause?.message ??
      `Server protocol ${options.server ?? 'unknown'} cannot satisfy client protocol ${options.clientRequires ?? 'unknown'}`;
    super(message, { reason: 'protocol_mismatch', cause: options.cause });
    this.source = options.source;
    this.server = options.server;
    this.clientRequires = options.clientRequires;
  }
}

/**
 * 接続できなかった、または応答の前に接続が閉じた。serverのerrorではないので`reason`を持たない。
 * 応答の前に閉じたrequestは、serverで処理されたかどうかが分からない。
 */
export class ConnectionError extends McRemoteError {
  override name = 'ConnectionError';
}

/** pairingの承認が、`auth.pairBegin`の`expires_in`の間に来なかった（wire 6.5）。 */
export class PairingExpiredError extends McRemoteError {
  override name = 'PairingExpiredError';

  constructor() {
    super('pairing code expired before approval', { reason: 'pair_expired' });
  }
}
