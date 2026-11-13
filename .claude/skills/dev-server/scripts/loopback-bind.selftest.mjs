/**
 * `node .claude/skills/dev-server/scripts/loopback-bind.selftest.mjs`
 *
 * Drives the real AppSession start/stop/exit path with a stand-in for vite that binds whatever
 * `--host` spawnArgs() names. Both loopback spellings must answer, a non-loopback address of this
 * machine must not, and the [::1] side must go away when the app does — by stop() and by a crash.
 */

import net from 'net';
import { spawn } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { networkInterfaces, tmpdir } from 'os';
import { resolve } from 'path';
import { AppSession, primaryCheckout } from './daemon.mjs';

const dir = mkdtempSync(resolve(tmpdir(), 'loopback-bind-'));
const stub = resolve(dir, 'stub-server.mjs');
writeFileSync(
  stub,
  `import http from 'http';
const [host, port] = process.argv.slice(2);
http.createServer((req, res) => res.end('ok')).listen({ host, port: Number(port) });
`
);

// The daemon refuses to start an app with no DATABASE_URL; the stand-in never connects to it.
const envFile = resolve(dir, 'stub.env');
writeFileSync(envFile, 'DATABASE_URL=postgres://127.0.0.1:1/none\n');

class StubApp extends AppSession {
  spawnArgs() {
    const args = super.spawnArgs();
    return ['exec', 'node', stub, args[args.indexOf('--host') + 1], String(this.port)];
  }
}

let failures = 0;
let skipped = 0;
function check(name, actual, expected) {
  const pass = actual === expected;
  if (!pass) failures++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}  got=${actual} want=${expected}`);
}

function connects(host, port) {
  return new Promise((done) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.on('error', () => done(false));
    socket.on('timeout', () => {
      socket.destroy();
      done(false);
    });
  });
}

async function get(host, port) {
  try {
    const res = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return `${res.status} ${await res.text()}`;
  } catch {
    return 'refused';
  }
}

async function until(fn, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function freePort() {
  return new Promise((done) => {
    const server = net.createServer();
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const { port } = server.address();
      server.close(() => done(port));
    });
  });
}

const lanAddresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => !a.internal && !a.address.startsWith('fe80'))
  .map((a) => a.address);

const hasV6Loopback = await new Promise((done) => {
  const server = net.createServer();
  server.once('error', () => done(false));
  server.listen({ host: '::1', port: 0, ipv6Only: true }, () => server.close(() => done(true)));
});
if (!hasV6Loopback) {
  console.log('SKIP  no IPv6 loopback on this machine; nothing to check');
  process.exit(1);
}

const port = await freePort();
const app = new StubApp('moderator', primaryCheckout, port, [envFile], []);

try {
  await app.start();
  check('stand-in came up on 127.0.0.1', await until(() => connects('127.0.0.1', port)), true);

  check('GET 127.0.0.1', await get('127.0.0.1', port), '200 ok');
  check('GET [::1]', await get('::1', port), '200 ok');

  if (!lanAddresses.length) {
    skipped++;
    console.log('SKIP  no non-loopback address on this machine; the non-loopback check cannot run');
  }
  for (const address of lanAddresses) {
    check(`connect ${address} refused`, await connects(address, port), false);
  }

  await app.stop();
  check('stop reports no held port', app.lastError, null);
  check('127.0.0.1 refused after stop', await connects('127.0.0.1', port), false);
  check('[::1] refused after stop', await connects('::1', port), false);

  await app.start();
  await until(() => connects('127.0.0.1', port));
  check('restart: GET [::1]', await get('::1', port), '200 ok');
  const proc = app.process;
  check('restart: app process running', !!proc, true);
  if (proc) {
    const crashed = new Promise((r) => proc.once('exit', r));
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t']);
    else process.kill(-proc.pid, 'SIGKILL');
    await crashed;
    const gone = await until(async () => !(await connects('::1', port)), 3000);
    check('crash: [::1] refused after the app exits', gone, true);
  }
} finally {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
}

console.log(
  `\n${failures ? `${failures} FAILED` : skipped ? 'INCOMPLETE (skipped checks)' : 'all passed'}`
);
process.exit(failures || skipped ? 1 : 0);
