// F1 fixtureのstepsを、localhostの実TCPで再生するscripted peer。
// fixtureの`client_send`をclientが送った行と比べ、`peer_*`をそのまま返す。
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import net from 'node:net';
import { clearTimeout, setImmediate, setTimeout } from 'node:timers';

const WAIT_MS = 2000;

export class FakeClock {
  #now = 0;
  /** sleepした長さ。呼ばれた順。 */
  slept = [];

  now() {
    return this.#now;
  }

  sleep(milliseconds) {
    this.slept.push(milliseconds);
    this.#now += milliseconds;
    return new Promise((resolve) => setImmediate(resolve));
  }

  advance(milliseconds) {
    this.#now += milliseconds;
  }
}

export async function startPeer(steps, clock) {
  const queued = [];
  const waiting = [];
  const accepted = [];
  const server = net.createServer((socket) => {
    const peerSocket = wrapSocket(socket);
    accepted.push(peerSocket);
    const waiter = waiting.shift();
    if (waiter) {
      waiter(peerSocket);
    } else {
      queued.push(peerSocket);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const nextSocket = () =>
    queued.length > 0 ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));

  const done = (async () => {
    let current;
    for (const [index, step] of steps.entries()) {
      const where = `step ${index} (${step.op})`;
      switch (step.op) {
        case 'connect':
          current = await within(nextSocket(), where);
          break;
        case 'client_send':
          assert.deepEqual(JSON.parse(await within(current.nextLine(), where)), step.message, where);
          break;
        case 'peer_send':
          current.socket.write(`${JSON.stringify(step.message)}\n`);
          break;
        case 'peer_bytes':
          current.socket.write(Buffer.from(step.bytes_hex, 'hex'));
          break;
        case 'peer_eof':
          current.socket.end();
          break;
        case 'client_close':
          await within(current.ended, where);
          break;
        case 'approve_pairing':
          break;
        case 'advance_time':
          clock.advance(step.milliseconds);
          break;
        case 'pause':
          // F1に無い、このrepositoryのunit test用のop。実時間で待つ。
          await new Promise((resolve) => setTimeout(resolve, step.milliseconds));
          break;
        default:
          throw new Error(`scripted peerが扱わないop: ${step.op}`);
      }
    }
  })();

  return {
    port: server.address().port,
    done,
    // stepsに無いのにclientが送った行と、開いた接続。
    unexpected() {
      return {
        lines: accepted.flatMap((peerSocket) => peerSocket.unread()),
        connections: queued.length,
      };
    },
    // stepsの後にclientが開いた接続の最初の行を読み、その接続を閉じる。
    async unscriptedLine() {
      const peerSocket = await within(nextSocket(), 'stepsの後の接続');
      const line = await within(peerSocket.nextLine(), 'stepsの後の接続の行');
      peerSocket.socket.destroy();
      return JSON.parse(line);
    },
    // clientが送ったmessage。すべての接続の、読んだ行と読んでいない行。
    received() {
      return accepted.flatMap((peerSocket) => peerSocket.received()).map((line) => JSON.parse(line));
    },
    async close() {
      for (const peerSocket of accepted) {
        peerSocket.socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// 接続を受けないportを返す。connect_errorのcase用。
export async function closedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function wrapSocket(socket) {
  const lines = [];
  const all = [];
  const readers = [];
  let buffer = Buffer.alloc(0);
  const ended = new Promise((resolve) => {
    socket.once('end', resolve);
    socket.once('close', resolve);
  });
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end = buffer.indexOf(0x0a); end !== -1; end = buffer.indexOf(0x0a)) {
      const line = buffer.subarray(0, end).toString('utf8');
      buffer = buffer.subarray(end + 1);
      all.push(line);
      const reader = readers.shift();
      if (reader) {
        reader(line);
      } else {
        lines.push(line);
      }
    }
  });
  return {
    socket,
    ended,
    nextLine: () =>
      lines.length > 0 ? Promise.resolve(lines.shift()) : new Promise((resolve) => readers.push(resolve)),
    unread: () => [...lines],
    received: () => [...all],
  };
}

function within(promise, where) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${where}: ${WAIT_MS}ms待っても来ない`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
