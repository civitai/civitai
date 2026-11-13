#!/usr/bin/env node
// Boots the built apps/moderator server (`node build`, adapter-node output) and fails unless it
// answers HTTP while still running. Typecheck and the unit suites never load the bundled server,
// so a defect that only exists in the Rollup output (a broken module namespace, a top-level throw
// in a chunk) reaches production unseen. This check sees it in the code the server loads at
// startup: the entry, `hooks.server.ts` and their imports. Route modules load lazily and the
// unauthenticated `GET /` is redirected before any route runs, so once the server has answered, a
// child process initialises the same `Server` and imports every route module in the manifest:
// each page and layout node, its component, and each `+server` endpoint. A module reached only
// through a dynamic `import()` inside one of them is still not covered.
//
// Any HTTP status counts as an answer: there is no database behind the placeholder env, so a page
// may well render an error. The question is only whether the server came up and stayed up.
//
// Usage: node scripts/ci/moderator-boot-smoke.mjs [appDir]   (default apps/moderator)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

if (process.argv[2] === '--load-modules') await loadModules(resolve(process.argv[3]));

// Run in a child by the check below, with the server's env. Initialises the server as adapter-node's
// handler does, then imports every lazily loaded route module and exits 1 naming each that throws.
async function loadModules(appDir) {
  const at = (path) => pathToFileURL(resolve(appDir, path)).href;
  const { Server } = await import(at('build/server/index.js'));
  const { manifest } = await import(at('build/server/manifest.js'));
  await new Server(manifest).init({
    env: process.env,
    read: () => {
      throw new Error('read() is not available in the boot smoke');
    },
  });

  // A node's own id is only known once it loads, so name it by a route it is the page of.
  const pageOf = new Map(manifest._.routes.filter((r) => r.page).map((r) => [r.page.leaf, r.id]));
  const loads = [
    ...manifest._.nodes.map((load, i) => ({
      name: `node ${i}${pageOf.has(i) ? ` (page ${pageOf.get(i)})` : ''}`,
      run: async () => {
        const node = await load();
        await node.component?.();
      },
    })),
    ...manifest._.routes
      .filter((route) => route.endpoint)
      .map((route) => ({ name: `endpoint ${route.id}`, run: () => route.endpoint() })),
  ];
  const results = await Promise.allSettled(loads.map((l) => l.run()));
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [[loads[i].name, r.reason]] : []));
  for (const [name, reason] of failed) console.error(`${name} failed to load:`, reason);
  console.log(`Loaded ${loads.length - failed.length} of ${loads.length} route modules.`);
  process.exit(failed.length ? 1 : 0);
}

const appDir = resolve(process.argv[2] ?? 'apps/moderator');
const port = Number(process.env.SMOKE_PORT ?? 3917);
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
// After the first answer, the server must still be running this long later, so a crash just
// after it starts listening still fails the check.
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

const loaded = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--load-modules', appDir], {
  env: { ...process.env, NODE_ENV: 'production' },
  stdio: 'inherit',
  timeout: timeoutMs,
});
if (loaded.status !== 0) {
  finish(false, `Server answered (HTTP ${status}), but route modules failed to load (exit ${loaded.status}, signal ${loaded.signal}).`);
}
finish(true, `Server booted, answered GET / with HTTP ${status}, and every route module in the manifest loaded.`);
