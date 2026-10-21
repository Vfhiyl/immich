import { execFileSync, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { connect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { redisPort } from 'src/storage-backends.js';

const isRedisUp = () =>
  new Promise<boolean>((resolve) => {
    const socket = connect(redisPort, 'localhost');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });

/** Make sure the server is built and Redis is running; a Redis started here is stopped afterwards */
export default async function setup() {
  const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../server');
  try {
    await access(resolve(serverRoot, 'dist/main.js'));
  } catch {
    throw new Error('The server is not built; run `pnpm --filter immich build` first');
  }

  // the S3 service is downloaded and verified by the server's contract test tools, run with Node's type stripping
  const tools = resolve(serverRoot, 'test/contract/tools.ts');
  process.env.E2E_VERSITYGW = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `const m = await import(${JSON.stringify(tools)}); console.log(await m.getTool(m.tools.versitygw));`,
  ])
    .toString()
    .trim();

  if (await isRedisUp()) {
    return;
  }

  const redis = spawn('redis-server', ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], {
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 50 && !(await isRedisUp()); attempt++) {
    await sleep(100);
  }

  return () => {
    redis.kill();
  };
}
