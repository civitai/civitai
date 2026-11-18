#!/usr/bin/env node
// `pnpm dev`: `next dev` plus a local feed-go (apps/feed-go) behind /api/trpc-go.
//
// - FEED_GO_LOCAL (real env or .env): unset/auto | binary | source | off. `off` runs `next dev` alone,
//   exactly as before (and leaves any FEED_GO_LOCAL_URL you set yourself in place).
// - Otherwise a loopback proxy starts first and Next starts at once with FEED_GO_LOCAL_URL pointing
//   at it (next.config.mjs rewrites /api/trpc-go/<p> there). The proxy sends each request to feed-go
//   while feed-go is healthy, else to Next's own /api/trpc/<p>: if feed-go never comes up, or dies,
//   the app behaves exactly as it did without it.
// - feed-go itself starts in the background: the pinned release binary (cached under
//   node_modules/.cache/feed-go, SHA256-verified), or a `go build` of apps/feed-go when Go is
//   installed. It gets an allow-listed slice of the app's env (lib.mjs buildFeedGoEnv), never all of
//   it, and its fallback points back at this Next.
// Every failure is one `[feed-go]` line; nothing here stops Next from starting.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFeedGoEnv,
  createFeedGoProxy,
  mergeFliptOverrides,
  missingRequired,
  nextPort,
  OS_VARS,
  parseVersion,
  readAppEnv,
  resolveBinary,
  resolveMode,
} from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const feedGoDir = join(root, 'apps/feed-go');
const log = (msg) => console.log(`[feed-go] ${msg}`);

const args = process.argv.slice(2);
const appEnv = readAppEnv(root, process.env);
const { mode, warning } = resolveMode(appEnv.FEED_GO_LOCAL);
if (warning) log(warning);

const nextEnv = { ...process.env };
let feedGoProc = null;
let feedGoTarget = null; // { host, port } while healthy
let proxy = null;
let shuttingDown = false;

if (mode !== 'off') {
  const port = nextPort(args, process.env);
  proxy = createFeedGoProxy({
    next: { host: 'localhost', port },
    feedGo: () => feedGoTarget,
    onFeedGoError: () => setHealthy(false, 'unreachable'),
  });
  const proxyPort = await listen(proxy);
  nextEnv.FEED_GO_LOCAL_URL = `http://127.0.0.1:${proxyPort}`;
  const overrides = mergeFliptOverrides(appEnv.FLIPT_LOCAL_OVERRIDES);
  if (overrides !== (appEnv.FLIPT_LOCAL_OVERRIDES ?? '')) nextEnv.FLIPT_LOCAL_OVERRIDES = overrides;
  startFeedGo(port).catch((err) => log(`not started (${err.message}); Next serves /api/trpc-go`));
}

const nextBin = createRequire(join(root, 'package.json')).resolve('next/dist/bin/next');
const nextProc = spawn(process.execPath, [nextBin, 'dev', ...args], {
  cwd: root,
  env: nextEnv,
  stdio: 'inherit',
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    shuttingDown = true;
    feedGoProc?.kill('SIGTERM');
    nextProc.kill(sig);
  });
}
nextProc.on('exit', (code, signal) => {
  shuttingDown = true;
  feedGoProc?.kill('SIGTERM');
  proxy?.close();
  process.exit(code ?? (signal ? 1 : 0));
});

async function startFeedGo(port) {
  const version = parseVersion(readFileSync(join(feedGoDir, 'package.json'), 'utf8'));
  const [addrPort, internalPort] = [await freePort(), await freePort()];
  const env = buildFeedGoEnv(appEnv, {
    addr: `127.0.0.1:${addrPort}`,
    internalAddr: `127.0.0.1:${internalPort}`,
    fallbackUrl: `http://localhost:${port}`,
  });
  const missing = missingRequired(env);
  if (missing.length) {
    log(`not started: the app env has no ${missing.join(', ')}; Next serves /api/trpc-go`);
    return;
  }

  const cacheDir = appEnv.FEED_GO_CACHE_DIR || join(root, 'node_modules/.cache/feed-go');
  let bin = null;
  let label = '';
  if (mode === 'auto' || mode === 'binary') {
    const r = await resolveBinary({
      version,
      platform: process.platform,
      arch: process.arch,
      cacheDir,
    });
    if (r.ok) [bin, label] = [r.path, `v${version} (release binary, ${r.source})`];
    else log(r.reason);
  }
  if (!bin && (mode === 'source' || mode === 'auto')) {
    if (hasGo()) {
      bin = await buildFromSource(version, cacheDir);
      label = `v${version}-dev (built from apps/feed-go)`;
    } else if (mode === 'source') {
      log('FEED_GO_LOCAL=source but `go` is not on PATH');
    }
  }
  if (!bin || shuttingDown) {
    if (!shuttingDown) log('not started; Next serves /api/trpc-go (set FEED_GO_LOCAL=off to skip)');
    return;
  }

  feedGoProc = spawn(bin, [], { cwd: feedGoDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  prefix(feedGoProc.stdout);
  prefix(feedGoProc.stderr);
  feedGoProc.on('error', (err) => log(`could not run ${bin}: ${err.message}`));
  feedGoProc.on('exit', (code, signal) => {
    feedGoTarget = null;
    if (!shuttingDown) {
      log(`exited (${signal ?? `code ${code}`}); Next serves /api/trpc-go until pnpm dev restarts`);
    }
  });
  watchHealth(internalPort, { host: '127.0.0.1', port: addrPort }, label);
}

let healthy = false;
function setHealthy(next, why, target, label) {
  if (next === healthy) return;
  healthy = next;
  feedGoTarget = next ? target : null;
  if (next) {
    log(`${label} ready; /api/trpc-go → feed-go (FEED_GO_LOCAL=off to use Node only)`);
  } else if (!shuttingDown) {
    log(`unhealthy (${why}); /api/trpc-go → Next until it recovers`);
  }
}

function watchHealth(internalPort, target, label) {
  const deadline = Date.now() + 60_000;
  const tick = async () => {
    if (shuttingDown || !feedGoProc || feedGoProc.exitCode !== null) return;
    let ok = false;
    try {
      const res = await fetch(`http://127.0.0.1:${internalPort}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      ok = res.ok;
    } catch {
      ok = false;
    }
    if (ok) setHealthy(true, '', target, label);
    else if (healthy) setHealthy(false, 'healthz failed');
    else if (Date.now() > deadline) {
      log('no healthy /healthz within 60s; Next serves /api/trpc-go');
      return;
    }
    setTimeout(tick, healthy ? 5000 : 1000).unref();
  };
  tick();
}

function hasGo() {
  return spawnSync('go', ['version'], { stdio: 'ignore' }).status === 0;
}

/** `go build` of apps/feed-go into the cache dir. The build sees only OS and Go variables. */
async function buildFromSource(version, cacheDir) {
  const out = join(cacheDir, 'source', process.platform === 'win32' ? 'feed-go.exe' : 'feed-go');
  await mkdir(dirname(out), { recursive: true });
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v && (OS_VARS.includes(k) || k.startsWith('GO') || k === 'XDG_CACHE_HOME')) env[k] = v;
  }
  env.CGO_ENABLED = '0';
  log('building apps/feed-go with go (the first build can take a minute)');
  const code = await new Promise((done) => {
    const p = spawn(
      'go',
      [
        'build',
        '-trimpath',
        '-ldflags',
        `-X main.version=${version}-dev`,
        '-o',
        out,
        './cmd/feed-go',
      ],
      { cwd: feedGoDir, env, stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', () => done(-1));
    p.on('exit', (c) => {
      if (c !== 0) log(`go build failed: ${err.trim().split('\n')[0] ?? ''}`);
      done(c);
    });
  });
  return code === 0 ? out : null;
}

function prefix(stream) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) if (line) console.log(`[feed-go] ${line}`);
  });
}

function listen(server) {
  return new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => done(server.address().port));
  });
}

async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((done) => s.close(done));
  return port;
}
