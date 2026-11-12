// つないで、ブロックを1つ置き、読み戻して、元へ戻す。実McRemoteとのpulseにも使う。
//
//   mise exec -- npm run build
//   MCREMOTE_HOST=<接続先> mise exec -- node examples/set-and-get-block.mjs
//
// 環境変数: MCREMOTE_HOST（必須）、MCREMOTE_PORT（既定25575）、
// MCREMOTE_POS（build originからの相対座標"x,y,z"、既定"0,100,0"）。
// tokenはこのprocessの中だけに持つので、実行のたびにMinecraftの中での承認が要る。
import process from 'node:process';

import { connect, memoryCredentialStore } from '@mc-remote/client';

const say = (line) => process.stdout.write(`${line}\n`);

const host = process.env.MCREMOTE_HOST;
if (!host) {
  process.stderr.write('MCREMOTE_HOSTを指定してください\n');
  process.exit(2);
}
const port = process.env.MCREMOTE_PORT ? Number(process.env.MCREMOTE_PORT) : undefined;
const [x, y, z] = (process.env.MCREMOTE_POS ?? '0,100,0').split(',').map(Number);

const fail = (error) => {
  say(`FAIL: ${error.name}${error.reason ? ` (${error.reason})` : ''}: ${error.message}`);
  process.exitCode = 1;
};

const remote = await connect({
  host,
  port,
  client: { name: 'minecraft-remote-typescript-example', version: '0.0.0', locale: 'ja' },
  credentials: memoryCredentialStore(),
  onPairing: ({ command, expiresInSeconds }) => {
    say(`Minecraftの中で、${expiresInSeconds}秒以内に次を実行してください: ${command}`);
  },
}).catch(fail);

if (remote) {
  try {
    say(`hello: protocol ${remote.hello.protocol}, Minecraft ${remote.hello.mc_version}`);

    // 元のブロックはIDとstateで戻す。チェストの中身や看板の文字など、getBlockで読めないものは戻らない。
    const before = await remote.getBlock(x, y, z);

    await remote.setBlock(x, y, z, 'gold_block');
    const placed = await remote.getBlock(x, y, z);
    say(`setBlock → getBlock: ${placed.block_id}`);
    if (placed.block_id !== 'minecraft:gold_block') throw new Error('置いたブロックを読み戻せない');

    await remote.setBlock(x, y, z, before);
    const restored = await remote.getBlock(x, y, z);
    say(`元へ戻した: ${restored.block_id}`);
    if (restored.block_id !== before.block_id) throw new Error('元のブロックへ戻せない');

    say('PASS');
  } catch (error) {
    fail(error);
  } finally {
    await remote.close();
  }
}
