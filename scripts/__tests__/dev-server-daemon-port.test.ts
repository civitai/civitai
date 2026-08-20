import { spawn } from 'child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_PORT,
  resolveDaemonPort,
} from '../../.claude/skills/dev-server/scripts/daemon-port.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = resolve(repoRoot, '.claude/skills/dev-server');
const daemonScript = resolve(skillDir, 'scripts/daemon.mjs');
const cliScript = resolve(skillDir, 'cli.mjs');
const pidFile = resolve(skillDir, 'daemon.pid');

/** A port nothing holds right now. Bound and released so the number is real, not a guess. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/**
 * The daemon writes its pid into the skill directory, and a developer running this suite has a
 * daemon of their own whose pid file that is. Every case here restores it.
 */
async function withPidFilePreserved<T>(body: () => Promise<T>): Promise<T> {
  const saved = existsSync(pidFile) ? readFileSync(pidFile) : null;
  try {
    return await body();
  } finally {
    if (saved) writeFileSync(pidFile, saved);
    else rmSync(pidFile, { force: true });
  }
}

/** Ask a daemon to stop over its own API — the one teardown that also works on Windows. */
async function shutdown(port: number) {
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => null);
}

describe('resolveDaemonPort', () => {
  it('is 9444 when the variable is unset or empty', () => {
    expect(resolveDaemonPort({})).toBe(9444);
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: '' })).toBe(9444);
    expect(DEFAULT_DAEMON_PORT).toBe(9444);
  });

  it('honours a numeric value', () => {
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: '9555' })).toBe(9555);
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: ' 9555 ' })).toBe(9555);
  });

  // parseInt — what every one of these call sites used to do — reads '9555abc' as 9555 and 'abc'
  // as NaN. NaN reaches a URL as `http://127.0.0.1:NaN` and fails somewhere far from the cause.
  it('refuses a value that is not a port instead of guessing one', () => {
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: 'abc' })).toThrow(/not a number/);
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: '9555abc' })).toThrow(/not a number/);
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: '-1' })).toThrow(/not a number/);
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: '0' })).toThrow(/out of range/);
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: '70000' })).toThrow(/out of range/);
  });
});

/**
 * The regression, and it needs a real daemon: the defect was that the value was read where the
 * client decides what to CONNECT to and ignored where the daemon decides what to LISTEN on, so a
 * test that imported functions would have seen a consistent-looking pair of constants and nothing
 * else. Only binding a socket tells the two apart.
 *
 * Measured on pre-change code with DEV_DAEMON_PORT=19461: the daemon logged `Daemon port: 9444`,
 * emitted no ready line, and nothing ever listened on 19461.
 */
describe('the dev daemon listens where DEV_DAEMON_PORT says', () => {
  type Ready = { type: string; port: number; pid: number };

  /** Run the real daemon to its ready line, probe it, then stop it. */
  async function daemonReady(env: Record<string, string>, args: string[] = []) {
    return withPidFilePreserved(async () => {
      const child = spawn(process.execPath, [daemonScript, ...args], {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        const ready = await new Promise<Ready | null>((done) => {
          let out = '';
          const timer = setTimeout(() => done(null), 30_000);
          const settle = (value: Ready | null) => {
            clearTimeout(timer);
            done(value);
          };
          child.stdout.on('data', (chunk: Buffer) => {
            out += chunk.toString();
            for (const line of out.split('\n')) {
              if (!line.trim().startsWith('{')) continue;
              try {
                const parsed = JSON.parse(line) as Ready;
                if (parsed.type === 'daemon_ready') settle(parsed);
              } catch {
                /* a partial line — wait for the rest */
              }
            }
          });
          child.stderr.resume();
          child.on('exit', () => settle(null));
        });

        // A port that answers proves a listener, not THIS listener. Matching the pid the daemon
        // reports against the child we spawned is what separates the two — an orphan left on a
        // port by an earlier run answers just as cheerfully.
        let reachable = false;
        if (ready) {
          const response = await fetch(`http://127.0.0.1:${ready.port}/`).catch(() => null);
          reachable = response?.ok === true;
        }
        return { ready, reachable, spawnedPid: child.pid };
      } finally {
        child.kill('SIGTERM');
        await new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) return done();
          const hard = setTimeout(() => child.kill('SIGKILL'), 5_000);
          child.on('exit', () => {
            clearTimeout(hard);
            done();
          });
        });
      }
    });
  }

  it('binds the port the environment names, with no arguments passed', async () => {
    const port = await freePort();
    const { ready, reachable, spawnedPid } = await daemonReady({ DEV_DAEMON_PORT: String(port) });

    expect(ready?.port).toBe(port);
    expect(reachable).toBe(true);
    expect(ready?.pid).toBe(spawnedPid);
  }, 60_000);

  it('lets an explicit --port beat the environment', async () => {
    const [envPort, argPort] = [await freePort(), await freePort()];
    expect(envPort).not.toBe(argPort);

    const { ready, reachable } = await daemonReady({ DEV_DAEMON_PORT: String(envPort) }, [
      '--port',
      String(argPort),
    ]);

    expect(ready?.port).toBe(argPort);
    expect(reachable).toBe(true);
  }, 60_000);
});

/**
 * The ledger. What made this bug possible was four files each deciding the port for themselves,
 * and it is not a bug any of them contains — it is a bug in the set. console.mjs in particular
 * has no end-to-end case here (it is a TUI), so a structural claim about the set is the only
 * thing standing between it and a second hardcoded 9444.
 *
 * This fails when the set grows (a new copy appears) and when it shrinks (daemon-port.mjs stops
 * owning the number).
 */
describe('nothing outside daemon-port.mjs decides the daemon port', () => {
  const owner = resolve(skillDir, 'scripts/daemon-port.mjs');
  const readers = [
    resolve(skillDir, 'cli.mjs'),
    resolve(skillDir, 'console.mjs'),
    resolve(skillDir, 'scripts/daemon.mjs'),
    resolve(repoRoot, 'scripts/test-unit-run.mjs'),
  ];

  it('spells 9444 exactly once, in the module that owns it', () => {
    // The positive control for the scan itself: the owner MUST contain the literal, or a typo in
    // these paths would read as "no copies anywhere" and pass.
    expect(readFileSync(owner, 'utf8')).toContain('9444');

    for (const file of readers) {
      expect(`${file}: ${readFileSync(file, 'utf8').includes('9444')}`).toBe(`${file}: false`);
    }
  });

  it('has every reader take the port from that module', () => {
    for (const file of readers) {
      const source = readFileSync(file, 'utf8');
      // Static `from '…/daemon-port.mjs'` in three of them; test-unit-run.mjs names the path and
      // imports it dynamically, because it must still run when `.claude/` is absent.
      expect(`${file}: ${source.includes('daemon-port.mjs')}`).toBe(`${file}: true`);
      expect(`${file}: ${source.includes('resolveDaemonPort(')}`).toBe(`${file}: true`);
    }
  });
});

/**
 * The seam neither half owns. cli.mjs resolved the port correctly and the daemon did not resolve
 * it at all, so two files that each looked right disagreed about where the daemon was. Driving
 * the real CLI is the only thing that builds the combined state.
 */
describe('the CLI reaches the daemon it starts', () => {
  it('starts a daemon on the port it is going to talk to', async () => {
    const port = await freePort();

    const result = await withPidFilePreserved(async () => {
      try {
        return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (done) => {
            const child = spawn(process.execPath, [cliScript, 'status'], {
              cwd: repoRoot,
              env: { ...process.env, DEV_DAEMON_PORT: String(port) },
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
            child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
            child.on('exit', (code) => done({ code, stdout, stderr }));
          }
        );
      } finally {
        await shutdown(port);
      }
    });

    // Pre-change this printed `Failed to start daemon` and exited 1: the daemon it had just
    // spawned was listening on 9444 while the CLI polled the port it had been told to use.
    expect(result.stderr).not.toMatch(/Failed to start daemon/);
    expect(result.code).toBe(0);
  }, 60_000);
});
