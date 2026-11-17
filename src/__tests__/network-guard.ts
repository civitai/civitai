/**
 * Unit tests may not open network connections. A connection a test did not set up itself fails
 * the test that made it, naming the host and port.
 *
 * Without this, a client nobody mocked connects to whatever the test env URL names. In CI nothing
 * answers and the failure is swallowed, so the test passes by accident; on a machine running that
 * service the test talks to it. Either way the test does not test what it claims to.
 *
 * Allowed:
 * - loopback ports this process is listening on (a test's own HTTP server);
 * - the service containers CI provides, through their dedicated test URLs (see `lint.yml`);
 * - pipes and Unix sockets;
 * - an address the current test names with `allowConnection`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, expect } from 'vitest';

type Attempt = { host: string; port: number; stack: string };

const DEDICATED_TEST_URL =
  /^(ROSTER_REDIS_URL|[A-Z0-9_]+_TEST_DATABASE_URL|[A-Z0-9_]+_PARITY_DATABASE_URL)$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);
const DEFAULT_PORTS: Record<string, number> = {
  'redis:': 6379,
  'postgres:': 5432,
  'postgresql:': 5432,
};

const listening = new Set<number>();
const allowed = new Set<string>();
for (const [name, value] of Object.entries(process.env)) {
  if (!value || !DEDICATED_TEST_URL.test(name)) continue;
  try {
    const url = new URL(value);
    allowed.add(key(url.hostname, Number(url.port) || DEFAULT_PORTS[url.protocol] || 0));
  } catch {
    // Not a URL: nothing to allow.
  }
}

function key(host: string, port: number) {
  return `${LOOPBACK.has(host) ? 'loopback' : host}:${port}`;
}

/** Allowed for the current test only. */
const allowedInTest = new Set<string>();

/**
 * Let the current test connect to `host:port`. For a connection the test sets up itself that the
 * guard cannot see: a server listening in a worker thread, or an address the test expects to
 * refuse.
 */
export function allowConnection(host: string, port: number) {
  allowedInTest.add(key(host, port));
}

function isAllowed(host: string, port: number) {
  if (LOOPBACK.has(host) && listening.has(port)) return true;
  return allowed.has(key(host, port)) || allowedInTest.has(key(host, port));
}

let attempts: Attempt[] = [];

const realListen = net.Server.prototype.listen;
net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address === 'object') listening.add(address.port);
  });
  return realListen.apply(this, args as Parameters<typeof realListen>);
} as typeof realListen;

// `fetch` opens its socket from undici's own queue, so the stack there ends inside undici. Carry the
// stack of the `fetch` call to the socket, so the failure names the code that made the request.
const fetchCaller = new AsyncLocalStorage<string>();
const realFetch = globalThis.fetch;
globalThis.fetch = ((...args: Parameters<typeof fetch>) =>
  fetchCaller.run(new Error().stack ?? '', () => realFetch(...args))) as typeof fetch;

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
  // `net.connect` passes its normalised `[options, callback]` pair as the first argument.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  let host = 'localhost';
  let port: number | undefined;
  if (first && typeof first === 'object') {
    const options = first as { path?: string; host?: string; port?: number | string };
    if (options.path) return realConnect.apply(this, args as Parameters<typeof realConnect>);
    host = options.host ?? host;
    port = Number(options.port);
  } else if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    port = Number(first);
    if (typeof args[1] === 'string') host = args[1];
  } else {
    // A pipe or Unix socket path.
    return realConnect.apply(this, args as Parameters<typeof realConnect>);
  }

  if (port === undefined || Number.isNaN(port) || isAllowed(host, port)) {
    return realConnect.apply(this, args as Parameters<typeof realConnect>);
  }

  attempts.push({ host, port, stack: fetchCaller.getStore() ?? new Error().stack ?? '' });
  const error = Object.assign(
    new Error(`unit tests may not open network connections (tried ${host}:${port})`),
    { code: 'ECONNREFUSED' }
  );
  process.nextTick(() => this.destroy(error));
  return this;
} as typeof realConnect;

// The report a full run collects, one JSON line per blocked attempt.
const REPORT_DIR = path.resolve('node_modules/.cache/network-guard');
function report(test: string, list: Attempt[]) {
  if (!process.env.NETWORK_GUARD_REPORT) return;
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    for (const a of list) {
      const frames = a.stack
        .split('\n')
        .filter((l) => /[\\/]src[\\/]|[\\/]packages[\\/]/.test(l) && !l.includes('network-guard'))
        .slice(0, 4)
        .map((l) => l.trim());
      appendFileSync(
        path.join(REPORT_DIR, `${process.pid}.jsonl`),
        JSON.stringify({
          file: expect.getState().testPath,
          test,
          host: a.host,
          port: a.port,
          frames,
        }) + '\n'
      );
    }
  } catch {
    // Reporting is best effort; the failure below is what counts.
  }
}

function describeAttempts(list: Attempt[]) {
  return [...new Set(list.map((a) => `${a.host}:${a.port}`))].join(', ');
}

// Attempts made while the file's modules loaded, before any test ran.
let atLoad: Attempt[] = [];
beforeEach(() => {
  if (attempts.length) {
    atLoad = atLoad.concat(attempts);
    report('(module load)', attempts);
    attempts = [];
  }
});

afterEach(() => {
  allowedInTest.clear();
  if (!attempts.length) return;
  const list = attempts;
  attempts = [];
  report(expect.getState().currentTestName ?? '(unknown)', list);
  throw new Error(
    `This test opened a network connection to ${describeAttempts(list)}. Mock the client that ` +
      'made it; unit tests never reach a real service. The stack of the first attempt:\n' +
      list[0].stack
  );
});

afterAll(() => {
  if (!atLoad.length) return;
  const list = atLoad;
  atLoad = [];
  throw new Error(
    `Loading this file's modules opened a network connection to ${describeAttempts(list)}. ` +
      'Mock the client that made it. The stack of the first attempt:\n' +
      list[0].stack
  );
});
