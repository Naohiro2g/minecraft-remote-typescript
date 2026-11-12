// pairingの期限、つなぎ直しの間隔、応答待ちの回収が使う時計。testでは仮想の時計に差し替える。
export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
  /** `milliseconds`の後に`callback`を呼ぶ。返した関数で取り消す。processを生かし続けない。 */
  setTimer(callback: () => void, milliseconds: number): () => void;
}

export const systemClock: Clock = {
  now: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  setTimer(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
