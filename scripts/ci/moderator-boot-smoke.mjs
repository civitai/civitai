#!/usr/bin/env node
// Boots the built apps/moderator server (`node build`, adapter-node output) and fails unless it
// answers HTTP while still running. Typecheck and the unit suites never load the bundled server,
// so a defect that only exists in the Rollup output (a broken module namespace, a top-level throw
// in a chunk) reaches production unseen; this is the check that can see it.
//
// Any HTTP status counts as an answer: there is no database behind the placeholder env, so a page
// may well render an error. The question is only whether the server came up and stayed up.
//
// Usage: node scripts/ci/moderator-boot-smoke.mjs [appDir]   (default apps/moderator)
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const appDir = resolve(process.argv[2] ?? 'apps/moderator');
const port = Number(process.env.SMOKE_PORT ?? 3917);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
// After the first answer, the server must still be running this long later: a crash on a lazily
// loaded chunk shows up just after the first request rather than at startup.
const settleMs = 3_000;

if (!existsSync(resolve(appDir, 'build/index.js'))) {
  console.error(`No build at ${appDir}/build/index.js. Run the app's build first.`);
  process.exit(1);
}

const child = spawn(process.execPath, ['build'], {
  cwd: appDir,
  env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let exited = null;
child.on('exit', (code, signal) => {
  exited = { code, signal };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function finish(ok, message) {
  if (exited === null) child.kill('SIGTERM');
  console[ok ? 'log' : 'error'](message);
  process.exit(ok ? 0 : 1);
}

const deadline = Date.now() + timeoutMs;
let status = null;
while (Date.now() < deadline) {
  if (exited !== null) {
    finish(false, `Server exited before answering HTTP (code ${exited.code}, signal ${exited.signal}).`);
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    });
    await res.arrayBuffer();
    status = res.status;
    break;
  } catch {
    await sleep(500);
  }
}

if (status === null) finish(false, `Server did not answer HTTP on port ${port} within ${timeoutMs}ms.`);

await sleep(settleMs);
if (exited !== null) {
  finish(false, `Server answered (HTTP ${status}) and then exited (code ${exited.code}, signal ${exited.signal}).`);
}
finish(true, `Server booted and answered GET / with HTTP ${status}.`);
