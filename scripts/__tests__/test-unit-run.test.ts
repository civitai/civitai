import { spawn } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

// The wrapper `pnpm run test:unit:run` now points at. Imported by path for the same reason the
// dev-server probes are: it runs under plain node and is never bundled.
import { queueDecision } from '../test-unit-run.mjs';

// The flag is what keeps this change invisible to CI and to anyone who does not run the daemon.
// If any of these flip, a shared script starts behaving differently for people who never opted in.
describe('test:unit:run — when the queue is used', () => {
  it('runs directly when the flag is unset, which is everyone by default', () => {
    expect(queueDecision([], {}).queue).toBe(false);
    expect(queueDecision([], {}).why).toMatch(/not set/);
  });

  it('runs directly in CI even with the flag set', () => {
    expect(queueDecision([], { CI: 'true', CIVITAI_TEST_QUEUE: '1' }).queue).toBe(false);
    expect(queueDecision([], { CI: 'true', CIVITAI_TEST_QUEUE: '1' }).why).toMatch(/CI/);
  });

  it('treats the usual off-values as off, not as "set"', () => {
    for (const value of ['0', 'false', 'off', 'no', 'FALSE', '']) {
      expect(queueDecision([], { CIVITAI_TEST_QUEUE: value }).queue).toBe(false);
    }
  });

  it('queues a bare full-suite run when the flag is on', () => {
    expect(queueDecision([], { CIVITAI_TEST_QUEUE: '1' }).queue).toBe(true);
    expect(queueDecision(['--reporter=dot'], { CIVITAI_TEST_QUEUE: '1' }).queue).toBe(true);
  });

  it('runs a file-scoped request directly — the fast loop must not queue behind a full suite', () => {
    const env = { CIVITAI_TEST_QUEUE: '1' };
    expect(queueDecision(['scripts/__tests__/a.test.ts'], env).queue).toBe(false);
    expect(queueDecision(['src/b.spec.tsx'], env).queue).toBe(false);
    expect(queueDecision(['--reporter=dot', 'src/c.test.mts'], env).queue).toBe(false);
  });

  it('does not mistake a flag value or a directory for a test file', () => {
    const env = { CIVITAI_TEST_QUEUE: '1' };
    // A trailing slash is a directory, and `--exclude '**/*.test.ts'` is a glob, not a target.
    expect(queueDecision(['--dir', 'src/x.test.ts/'], env).queue).toBe(true);
    expect(queueDecision(['--reporter=verbose'], env).queue).toBe(true);
  });
});

/**
 * The verdict a queued run reports to its caller.
 *
 * These drive the real script as a child process against a stub daemon, because the bug this
 * pins was invisible to any test that imported a function: the decision lived inline in the poll
 * loop, so the only thing that ever evaluated it was the process exiting. `DEV_DAEMON_PORT` (the
 * override the CLI already honoured) is what lets a fake daemon stand beside the shared one.
 */
describe('test:unit:run — the exit code a queued run reports', () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const script = resolve(repoRoot, 'scripts/test-unit-run.mjs');

  /** A daemon that hands back one fixed run view, whatever is asked of it. */
  async function stubDaemon(view: Record<string, unknown>) {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        req.url?.includes('/logs')
          ? JSON.stringify({ logs: [] })
          : JSON.stringify({ id: 'stub', position: 0, queueLength: 0, logIndex: 0, ...view })
      );
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    return { port, close: () => new Promise<void>((done) => server.close(() => done())) };
  }

  async function runAgainst(view: Record<string, unknown>) {
    const daemon = await stubDaemon(view);
    try {
      return await new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, [script], {
          cwd: repoRoot,
          env: {
            ...process.env,
            CI: '',
            CIVITAI_TEST_QUEUE: '1',
            DEV_DAEMON_PORT: String(daemon.port),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => (stderr += d.toString()));
        child.stdout.resume();
        child.on('exit', (code) => done({ code, stderr }));
      });
    } finally {
      await daemon.close();
    }
  }

  /**
   * The regression. A run killed by a signal records no exit code of its own, which the queue
   * stores as -1. The waiter used to pass that straight to `process.exit`, and `process.exit(-1)`
   * hands the shell 255 — a number that means nothing here, that `[ $? -eq 1 ]` misreads, and
   * that `exitCodeFor` was written to prevent. Measured at 255 before this changed.
   */
  it.each([
    ['cancelled', -1],
    ['timeout', -1],
    ['error', -1],
  ])('reports 1, not 255, for a %s run the queue recorded as %i', async (status, exitCode) => {
    const { code } = await runAgainst({ status, exitCode });
    expect(code).toBe(1);
  });

  // Invariant guards, not regression coverage: these already held. They are here so a later
  // "simplification" of the verdict cannot quietly change what a pass and a fail mean.
  it.each([
    ['completed', 0, 0],
    ['failed', 1, 1],
    ['failed', 3, 3],
    // A cancelled run can carry a 0: the child exited cleanly in the window between the kill
    // being issued and it landing. That is not a pass.
    ['cancelled', 0, 1],
  ])('maps %s/%i to %i', async (status, exitCode, expected) => {
    const { code } = await runAgainst({ status, exitCode });
    expect(code).toBe(expected);
  });

  /**
   * The other half of "green means nothing": a log the queue clipped reads exactly like a whole
   * one. The sentence is pinned in full rather than by keyword, because a reworded warning that
   * still omits the number would walk a `toContain('INCOMPLETE')` check.
   */
  it('says so, in full, when the log it printed is a fragment', async () => {
    const { stderr } = await runAgainst({
      status: 'failed',
      exitCode: 1,
      logIndex: 5000,
      logsDropped: 3002,
    });
    expect(stderr.replace(/\s+/g, ' ')).toContain(
      'WARNING: this log is INCOMPLETE — the queue dropped the oldest 3002 of 5000 output lines. ' +
        'Do not read the text above as the whole run.'
    );
  });

  it('stays quiet when nothing was dropped — the warning must mean something', async () => {
    const { stderr } = await runAgainst({ status: 'failed', exitCode: 1, logsDropped: 0 });
    expect(stderr).not.toContain('INCOMPLETE');
  });
});
