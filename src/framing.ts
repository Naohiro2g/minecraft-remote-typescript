// 直TCP経路のframing（wire 2）。1行＝1つのcompact JSONで、LF（0x0A）で終わる。

const LF = 0x0a;

/** 受け取ったbyte列を行に分け、JSONとして読めた値を返す。LFが届くまでの末尾は保持する。 */
export class LineDecoder {
  #tail: Uint8Array = new Uint8Array(0);
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });
  readonly #onInvalidLine: ((line: Uint8Array) => void) | undefined;

  constructor(options?: { onInvalidLine?: (line: Uint8Array) => void }) {
    this.#onInvalidLine = options?.onInvalidLine;
  }

  /** LFがまだ届いていない末尾。JSONとして閉じていても、ここに残る。 */
  get tail(): Uint8Array {
    return this.#tail;
  }

  push(chunk: Uint8Array): unknown[] {
    const bytes = concat(this.#tail, chunk);
    const values: unknown[] = [];
    let start = 0;
    for (let end = bytes.indexOf(LF); end !== -1; end = bytes.indexOf(LF, start)) {
      const line = bytes.subarray(start, end);
      start = end + 1;
      try {
        values.push(JSON.parse(this.#utf8.decode(line)));
      } catch {
        // JSONでない行は捨てる（wire 2）。
        this.#onInvalidLine?.(line);
      }
    }
    this.#tail = new Uint8Array(bytes.subarray(start));
    return values;
  }
}

/** 1つのmessageをcompact JSONにし、LFで終える。JSON.stringifyは文字列の中の改行をescapeする。 */
export function encodeFrame(message: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(message)}\n`);
}

function concat(head: Uint8Array, tail: Uint8Array): Uint8Array {
  if (head.length === 0) return tail;
  const bytes = new Uint8Array(head.length + tail.length);
  bytes.set(head);
  bytes.set(tail, head.length);
  return bytes;
}
