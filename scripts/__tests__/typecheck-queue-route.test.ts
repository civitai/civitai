import { spawn } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * What a script ENQUEUES, observed on the wire. Drives the real script as a child process against a
 * stub daemon on DEV_DAEMON_PORT, the same arrangement as test-unit-run.test.ts.
 *
 * 🔴 The kind is the whole contract here, and nothing else checks it. A typecheck posted WITHOUT
 * `kind: 'typecheck'` is accepted as a unit run, so the daemon spawns `pnpm run test:unit:run` —
 * the caller asked for a one-core tsc and gets a 31-worker suite, reported under the right exit
 * code. Every other test in this area would stay green.
 */
async function enqueuedBy(script: string) {
  const posted: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/test-runs') posted.push(JSON.parse(body || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        req.url?.includes('/logs')
          ? JSON.stringify({ logs: [] })
          : JSON.stringify({
              id: 'stub',
              status: 'completed',
              exitCode: 0,
              position: 0,
              queueLength: 0,
              logIndex: 0,
            })
      );
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;

  try {
    await new Promise<void>((done) => {
      const child = spawn(process.execPath, [resolve(repoRoot, script)], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: '',
          CIVITAI_TEST_QUEUE: '1',
          DEV_DAEMON_PORT: String(port),
          TYPECHECK_TSC_PATH: '',
          TYPECHECK_HEAP_MB: '',
        },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      // Bounded on its own. If routing is broken the script falls through to a REAL tsc, which
      // runs for minutes; killing it here turns that into the assertion below naming what was
      // (not) posted, instead of a 60s test timeout that says nothing.
      const cap = setTimeout(() => child.kill(), 15_000);
      child.on('exit', () => {
        clearTimeout(cap);
        done();
      });
    });
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
  return posted;
}

describe('what each script enqueues', () => {
  it('a full typecheck enqueues in the typecheck lane', async () => {
    const posted = await enqueuedBy('scripts/typecheck.mjs');
    expect(posted.map((p) => p.kind)).toEqual(['typecheck']);
  });

  it('a full unit run enqueues in the unit lane', async () => {
    const posted = await enqueuedBy('scripts/test-unit-run.mjs');
    expect(posted.map((p) => p.kind)).toEqual(['unit']);
  });
});
