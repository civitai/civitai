/**
 * Two things a daemon owns and must not take from another daemon: its pid file, and the capture
 * files of runs that are still going.
 *
 * Both are shared-namespace problems that only became reachable once `DEV_DAEMON_PORT` actually
 * worked, and both fail in the direction that destroys someone else's state rather than your own.
 */
import { spawn } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_PORT,
  isPidAlive,
  pidFileFor,
  readPidFile,
  removePidFileIfOwned,
} from '../../.claude/skills/dev-server/scripts/daemon-port.mjs';
import {
  captureFileName,
  createOutputCapture,
  ownerPidOf,
  sweepStaleCaptures,
} from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = resolve(repoRoot, '.claude/skills/dev-server');
const cliScript = resolve(skillDir, 'cli.mjs');

const tempDirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'devsrv-identity-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

/** A port nothing holds right now. Bound and released so the number is real, not a guess. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

/** True once nothing answers on the port. */
async function isDown(port: number): Promise<boolean> {
  return (await fetch(`http://127.0.0.1:${port}/`).catch(() => null)) === null;
}

function run(script: string, args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('exit', (code) => done({ code, out }));
  });
}

// ── the pid file names one process ───────────────────────────────────────────

describe('a pid file is scoped to a port', () => {
  it('keeps the plain name on the default port and only there', () => {
    // The documented check is `readlink -f /proc/$(cat .../daemon.pid)/exe`, so the shared
    // daemon's file must keep its name. Everything else gets its own.
    expect(basename(pidFileFor('/skill', DEFAULT_DAEMON_PORT))).toBe('daemon.pid');
    expect(basename(pidFileFor('/skill', 9555))).toBe('daemon-9555.pid');
    expect(basename(pidFileFor('/skill', 19733))).toBe('daemon-19733.pid');
    // Two daemons on two ports name two files. This is the whole property.
    expect(pidFileFor('/skill', 9555)).not.toBe(pidFileFor('/skill', DEFAULT_DAEMON_PORT));
  });
});

describe('readPidFile', () => {
  it('reads a pid, and refuses to invent one', () => {
    const dir = scratch();
    const path = join(dir, 'daemon.pid');

    writeFileSync(path, '12345');
    expect(readPidFile(path)).toBe(12345);
    writeFileSync(path, ' 12345\n');
    expect(readPidFile(path)).toBe(12345);

    // A caller acts on this. Guessing a number out of a truncated or replaced file is how a LIVE
    // process gets treated as a dead one.
    expect(readPidFile(join(dir, 'nope.pid'))).toBeNull();
    for (const junk of ['', '   ', 'abc', '123abc', '-1', '0', '1.5']) {
      writeFileSync(path, junk);
      expect(readPidFile(path)).toBeNull();
    }
  });
});

describe('isPidAlive', () => {
  it('says yes to a process that exists', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('says no to a pid nothing holds', async () => {
    // A real pid observed dying, rather than a large number guessed to be free.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const pid = child.pid!;
    await new Promise<void>((done) => child.on('exit', () => done()));
    // The exit event fires before the parent has reaped it in some node versions; a beat settles it.
    await new Promise((r) => setTimeout(r, 50));
    expect(isPidAlive(pid)).toBe(false);
  });

  it('rejects a value that is not a pid instead of asking the kernel about it', () => {
    for (const bad of [0, -1, 1.5, NaN]) expect(isPidAlive(bad as number)).toBe(false);
  });

  /**
   * EPERM means the process EXISTS and belongs to somebody else. pid 1 is init, owned by root, and
   * this suite does not run as root — so the kernel refuses the signal for a process that is very
   * much alive. Reading that refusal as "gone" is the one wrong answer that does damage: it is
   * what would let this sweep delete another developer's running capture.
   */
  it('counts a process it is not allowed to signal as alive', () => {
    expect(isPidAlive(1)).toBe(true);
  });
});

describe('removePidFileIfOwned', () => {
  it('removes a file that names the caller', () => {
    const path = join(scratch(), 'daemon.pid');
    writeFileSync(path, String(process.pid));
    expect(removePidFileIfOwned(path, process.pid)).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('leaves a file that names somebody else', () => {
    const path = join(scratch(), 'daemon.pid');
    writeFileSync(path, '424242');
    expect(removePidFileIfOwned(path, process.pid)).toBe(false);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('424242');
  });

  it('is a no-op on a file that is not there', () => {
    expect(removePidFileIfOwned(join(scratch(), 'gone.pid'), process.pid)).toBe(false);
  });
});

/**
 * The end-to-end case, and the one actually hit in anger on 2026-08-19: a probe daemon on its own
 * port shut down and took the shared `daemon.pid` — which named the LIVE daemon on 9444 — with it,
 * breaking `readlink -f /proc/$(cat daemon.pid)/exe`.
 *
 * This drives the real CLI against a real second daemon. Reproduced before the change with a
 * sentinel in `daemon.pid`: `DEV_DAEMON_PORT=<free> cli.mjs status` replaced the sentinel with the
 * probe daemon's pid, and `DEV_DAEMON_PORT=<free> cli.mjs shutdown` then deleted the file.
 *
 * That measurement is why the assertion below is about the file's CONTENT and not only about it
 * existing, and why an ownership check alone was not the fix: by shutdown time the probe daemon
 * genuinely owned the shared file, so "only delete what names me" would have deleted it too. Both
 * halves — the clobber at start and the delete at stop — are asserted here.
 */
describe('a second daemon leaves the first one’s pid file alone', () => {
  /**
   * Both daemons are on ports this case allocated, and NEITHER is the default one.
   *
   * Deliberately not the real `daemon.pid`: that file belongs to whatever daemon the developer is
   * running, and `dev-server-daemon-port.test.ts` saves and restores it in cases that run in
   * parallel with this one — two files racing over one path fails on the bookkeeping instead of on
   * the property. The property does not need the default port anyway. It is that two daemons do not
   * share a pid file, and `pidFileFor` above pins the one thing the default port adds: its name.
   */
  it('neither overwrites nor deletes it', async () => {
    const firstPort = await freePort();
    const probePort = await freePort();
    expect(firstPort).not.toBe(probePort);
    const firstPidFile = pidFileFor(skillDir, firstPort);
    const probePidFile = pidFileFor(skillDir, probePort);

    try {
      // A real daemon standing in for the shared one — its pid file names a process that is
      // genuinely running, which is what made the loss matter.
      const first = await run(cliScript, ['status'], { DEV_DAEMON_PORT: String(firstPort) });
      expect(first.out).not.toMatch(/Failed to start daemon/);
      expect(existsSync(firstPidFile)).toBe(true);
      const firstPid = readPidFile(firstPidFile);
      expect(firstPid).not.toBeNull();
      expect(isPidAlive(firstPid!)).toBe(true);

      // The probe daemon beside it. Pre-change, starting this OVERWROTE the record above.
      const probe = await run(cliScript, ['status'], { DEV_DAEMON_PORT: String(probePort) });
      expect(probe.out).not.toMatch(/Failed to start daemon/);
      expect(readPidFile(firstPidFile)).toBe(firstPid);
      expect(existsSync(probePidFile)).toBe(true);

      // …and stopping it DELETED it, while the daemon it named was still serving.
      await run(cliScript, ['shutdown'], { DEV_DAEMON_PORT: String(probePort) });
      for (let i = 0; i < 100 && !(await isDown(probePort)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Long enough to cover the daemon's 100 ms post-response unlink timer several times over.
      await new Promise((r) => setTimeout(r, 600));

      expect(existsSync(firstPidFile)).toBe(true);
      expect(readPidFile(firstPidFile)).toBe(firstPid);
      // The first daemon is still serving — the record and the process both survived.
      expect(await isDown(firstPort)).toBe(false);
      // And the probe cleaned up after itself, the other half of owning your own file.
      expect(existsSync(probePidFile)).toBe(false);
    } finally {
      await fetch(`http://127.0.0.1:${firstPort}/shutdown`, { method: 'POST' }).catch(() => null);
      for (let i = 0; i < 100 && !(await isDown(firstPort)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      rmSync(firstPidFile, { force: true });
      rmSync(probePidFile, { force: true });
    }
  }, 120_000);
});

/**
 * The daemon's own half of the same rule: on the way out it removes its pid file only if the file
 * still names IT.
 *
 * Port scoping is what fixed the reported bug; this guard covers what scoping cannot — a pid file
 * that has been rewritten under a running daemon. That is a state this tooling reaches on its own:
 * `cli.mjs startDaemon` writes the pid of the process IT spawned after spawning it, and the daemon
 * writes its own pid when it starts, so a fast daemon start lands the two writes in the other
 * order and the file ends up naming the wrapper rather than the daemon.
 */
describe('a daemon does not remove a pid file that names somebody else', () => {
  it('leaves a rewritten pid file alone on shutdown', async () => {
    const port = await freePort();
    const pidFile = pidFileFor(skillDir, port);
    try {
      const started = await run(cliScript, ['status'], { DEV_DAEMON_PORT: String(port) });
      expect(started.out).not.toMatch(/Failed to start daemon/);
      expect(existsSync(pidFile)).toBe(true);

      // Rewrite it to name a different, LIVE process — this test runner.
      writeFileSync(pidFile, String(process.pid));

      // Straight to the daemon, so this is the daemon's decision and not the CLI's.
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => null);
      for (let i = 0; i < 100 && !(await isDown(port)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 600));

      expect(existsSync(pidFile)).toBe(true);
      expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
    } finally {
      rmSync(pidFile, { force: true });
    }
  }, 120_000);

  /**
   * The same rule on the SIGNAL paths, which the HTTP case above does not reach.
   *
   * Three exits remove the pid file — `POST /shutdown`, SIGINT and SIGTERM — and they are three
   * separate pieces of code. Mutation found this: reverting only the SIGTERM handler to an
   * unconditional unlink survived a suite that covered `/shutdown`, so the guard on two of the
   * three exits was asserted by nothing.
   *
   * The daemon is spawned DIRECTLY rather than through the CLI, so `child.pid` is the daemon
   * itself and the signal is delivered by a pid this test resolved rather than matched.
   */
  const signalCase = (signal: 'SIGTERM' | 'SIGINT') =>
    it(`leaves a rewritten pid file alone on ${signal}`, async () => {
      const port = await freePort();
      const pidFile = pidFileFor(skillDir, port);
      const daemon = spawn(process.execPath, [resolve(skillDir, 'scripts/daemon.mjs')], {
        cwd: repoRoot,
        env: { ...process.env, DEV_DAEMON_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      daemon.stdout.resume();
      daemon.stderr.resume();

      try {
        for (let i = 0; i < 200 && (await isDown(port)); i++) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(await isDown(port)).toBe(false);
        expect(readPidFile(pidFile)).toBe(daemon.pid);

        // Rewrite it to name a different, LIVE process — this test runner.
        writeFileSync(pidFile, String(process.pid));

        daemon.kill(signal);
        await new Promise<void>((done) => daemon.on('exit', () => done()));

        expect(existsSync(pidFile)).toBe(true);
        expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
      } finally {
        daemon.kill('SIGKILL');
        rmSync(pidFile, { force: true });
      }
    }, 120_000);

  signalCase('SIGTERM');
  signalCase('SIGINT');

  /**
   * The positive control for both signal paths: left alone, the daemon DOES remove its own file.
   * Without this, "leaves a rewritten one alone" is satisfied by a handler that never removes
   * anything, and every stopped daemon would leave a pid file behind for good.
   */
  it('removes its own pid file on SIGTERM', async () => {
    const port = await freePort();
    const pidFile = pidFileFor(skillDir, port);
    const daemon = spawn(process.execPath, [resolve(skillDir, 'scripts/daemon.mjs')], {
      cwd: repoRoot,
      env: { ...process.env, DEV_DAEMON_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.resume();
    daemon.stderr.resume();

    try {
      for (let i = 0; i < 200 && (await isDown(port)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(readPidFile(pidFile)).toBe(daemon.pid);

      daemon.kill('SIGTERM');
      await new Promise<void>((done) => daemon.on('exit', () => done()));

      expect(existsSync(pidFile)).toBe(false);
    } finally {
      daemon.kill('SIGKILL');
      rmSync(pidFile, { force: true });
    }
  }, 120_000);
});

/**
 * `cli.mjs shutdown` cleans up a LEFTOVER pid file, and only a leftover one.
 *
 * Port scoping fixed which file it reaches for; this is about what it does once it has it. The
 * reachable damaging case is a daemon that accepts `/shutdown` and then does not go away — it
 * awaits `rgbProxy.stop()`, `authHub.stop()` and `stopSpokeApps()` before exiting, and a hang in
 * any of those leaves it serving. Deleting its pid file at that moment throws away the record of a
 * process that is still running, which is the same damage in a smaller blast radius.
 */
describe('cmdShutdown only removes a pid file with nothing behind it', () => {
  /** A stub that answers /shutdown 200 and keeps running — the daemon that accepted and hung. */
  async function acceptButStayUp() {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { server, port: (server.address() as AddressInfo).port };
  }

  it('keeps a pid file whose process is still alive', async () => {
    const { server, port } = await acceptButStayUp();
    const pidFile = pidFileFor(skillDir, port);
    try {
      writeFileSync(pidFile, String(process.pid));
      const result = await run(cliScript, ['shutdown'], { DEV_DAEMON_PORT: String(port) });
      expect(result.out).toMatch(/Daemon shutdown/);
      expect(existsSync(pidFile)).toBe(true);
      expect(readFileSync(pidFile, 'utf8')).toBe(String(process.pid));
    } finally {
      rmSync(pidFile, { force: true });
      await new Promise<void>((done) => server.close(() => done()));
    }
  }, 60_000);

  /**
   * The positive control. Without it, "keeps a live one" is satisfied by a cmdShutdown that never
   * removes anything at all, and the leftover files it exists to clean up would accumulate
   * forever with a green suite.
   */
  it('removes a pid file whose process is gone', async () => {
    const port = await freePort();
    const pidFile = pidFileFor(skillDir, port);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid!;
    await new Promise<void>((done) => child.on('exit', () => done()));
    await new Promise((r) => setTimeout(r, 50));

    try {
      writeFileSync(pidFile, String(deadPid));
      // Nothing is listening on `port`, which is the other half of this shape: the daemon is
      // already gone and its file was never cleaned up.
      await run(cliScript, ['shutdown'], { DEV_DAEMON_PORT: String(port) });
      expect(existsSync(pidFile)).toBe(false);
    } finally {
      rmSync(pidFile, { force: true });
    }
  }, 60_000);
});

// ── the capture reaper ───────────────────────────────────────────────────────

describe('ownerPidOf', () => {
  /**
   * The seam. `createOutputCapture` writes the name and the sweep reads it, and a sweep whose
   * pattern has drifted from the writer finds nothing — which is indistinguishable from a clean
   * /tmp and would report a reassuring zero forever.
   *
   * So this parses a name a REAL capture produced, rather than one this test typed out.
   */
  it('parses the pid out of a name the capture actually created', () => {
    const capture = createOutputCapture(() => {});
    try {
      expect(ownerPidOf(basename(capture.path))).toBe(process.pid);
    } finally {
      capture.close();
    }
  });

  it('claims nothing it did not write', () => {
    const uuid = '0189d8f1-6f1a-7c3a-9b4e-2f7c1d5a8e30';
    expect(ownerPidOf(captureFileName(4321, uuid))).toBe(4321);

    for (const name of [
      'civitai-test-run.log', // no pid, no uuid
      `civitai-test-run-${uuid}.log`, // uuid where the pid goes
      `civitai-test-run-abc-${uuid}.log`, // pid that is not a number
      `civitai-test-run-0-${uuid}.log`, // pid 0 is not a process
      `civitai-test-run-4321-${uuid}`, // no suffix
      `civitai-test-run-4321-${uuid}.log.tmp`, // suffix, but not at the end
      // A DIFFERENT four-character extension, which is the case that catches a check that only
      // slices the suffix off without testing for it: `.slice(prefix, -4)` removes `.txt` just as
      // happily as `.log` and then matches, so this name would be claimed — and deleted — even
      // though nothing here writes a .txt. (Found by mutation: dropping the `endsWith` test
      // survived the rest of this list.)
      `civitai-test-run-4321-${uuid}.txt`,
      `civitai-test-run-4321-${uuid}.bak`,
      `civitai-test-run-4321-not-a-uuid.log`,
      `prefix-civitai-test-run-4321-${uuid}.log`, // ours, but not at the start
      'important-user-data.log',
      'systemd-private-abcdef',
    ]) {
      expect(ownerPidOf(name), name).toBeNull();
    }
  });
});

describe('sweepStaleCaptures', () => {
  /** Lays out a directory of capture-shaped files plus a decoy, and returns their names. */
  function seed(dir: string) {
    const uuid = (n: number) => `0189d8f1-6f1a-7c3a-9b4e-2f7c1d5a8e${String(n).padStart(2, '0')}`;
    const dead = captureFileName(424242, uuid(1));
    const live = captureFileName(process.pid, uuid(2));
    const decoy = 'important-user-data.log';
    for (const name of [dead, live, decoy]) writeFileSync(join(dir, name), 'x');
    return { dead, live, decoy };
  }

  it('removes an orphan and keeps a file whose owner is still running', () => {
    const dir = scratch();
    const { dead, live, decoy } = seed(dir);

    const result = sweepStaleCaptures({ dir, isAlive: (pid: number) => pid === process.pid });

    expect(result.removed).toEqual([dead]);
    expect(result.kept).toEqual([live]);
    expect(result.errors).toEqual([]);
    expect(existsSync(join(dir, dead))).toBe(false);
    // The two that must survive: a live run's capture, and a file that was never ours.
    expect(existsSync(join(dir, live))).toBe(true);
    expect(existsSync(join(dir, decoy))).toBe(true);
  });

  /**
   * The positive control for the aliveness rule itself.
   *
   * With `isAlive` injected, a sweep that never consults it is indistinguishable from one that
   * consults it correctly — both report the same result on the case above. Making EVERY pid alive
   * must produce zero removals; if it does not, the sweep is deciding on something else.
   */
  it('removes nothing when every owner is alive', () => {
    const dir = scratch();
    const { dead, live } = seed(dir);

    const result = sweepStaleCaptures({ dir, isAlive: () => true });

    expect(result.removed).toEqual([]);
    expect(result.kept.sort()).toEqual([dead, live].sort());
    expect(existsSync(join(dir, dead))).toBe(true);
  });

  /** And the negative control: with nothing alive, both captures go and the decoy stays. */
  it('removes every capture when no owner is alive', () => {
    const dir = scratch();
    const { dead, live, decoy } = seed(dir);

    const result = sweepStaleCaptures({ dir, isAlive: () => false });

    expect(result.removed.sort()).toEqual([dead, live].sort());
    expect(result.kept).toEqual([]);
    expect(existsSync(join(dir, decoy))).toBe(true);
  });

  /**
   * Against the REAL aliveness rule, not an injected one — the seam between the sweep and
   * `isPidAlive`. A sweep wired to a default that always returns true would pass every case above
   * and still never delete anything in production.
   */
  it('defaults to the real process check', async () => {
    const dir = scratch();
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid!;
    await new Promise<void>((done) => child.on('exit', () => done()));
    await new Promise((r) => setTimeout(r, 50));

    const uuid = '0189d8f1-6f1a-7c3a-9b4e-2f7c1d5a8e99';
    const orphan = captureFileName(deadPid, uuid);
    const mine = captureFileName(process.pid, uuid);
    writeFileSync(join(dir, orphan), 'x');
    writeFileSync(join(dir, mine), 'x');

    const result = sweepStaleCaptures({ dir });

    expect(result.removed).toEqual([orphan]);
    expect(result.kept).toEqual([mine]);
  });

  it('reports a directory it cannot read rather than answering zero', () => {
    const result = sweepStaleCaptures({ dir: join(scratch(), 'no-such-dir') });
    expect(result.errors).toHaveLength(1);
    expect(result.removed).toEqual([]);
  });

  /**
   * The end-to-end shape the reaper exists for: a capture whose owner died without releasing it.
   * Built from a real `createOutputCapture` — its file, its name — so the thing swept is the thing
   * the queue actually writes rather than a fixture that agrees with the sweep by construction.
   */
  it('sweeps a real capture file whose owner is gone', async () => {
    const dir = scratch();
    const capture = createOutputCapture(() => {});
    const name = basename(capture.path);
    try {
      // Same name, in a directory this test owns — /tmp itself holds other developers' runs.
      writeFileSync(join(dir, name), 'x');
      expect(existsSync(join(dir, name))).toBe(true);

      // Its owner is this process, which is alive: the sweep must leave it.
      expect(sweepStaleCaptures({ dir }).removed).toEqual([]);
      expect(existsSync(join(dir, name))).toBe(true);

      // Now say the owner is gone — the -9'd daemon — and it goes.
      const result = sweepStaleCaptures({ dir, isAlive: (pid: number) => pid !== process.pid });
      expect(result.removed).toEqual([name]);
      expect(existsSync(join(dir, name))).toBe(false);
    } finally {
      capture.close();
    }
  });

  /**
   * The seam nobody owns: a sweep that is correct and never called.
   *
   * Every case above drives `sweepStaleCaptures` directly, so all of them stay green if the
   * daemon's call to it is deleted — and the orphans would pile up exactly as they did before.
   * This starts a REAL daemon and asks whether a planted orphan survived it.
   *
   * The orphan goes in the real tmpdir, because that is the directory the daemon sweeps and
   * pointing it elsewhere is the thing under test. It is safe to plant: its pid segment names a
   * process observed exiting, so no other run can own it, and it is the only file this case
   * touches.
   */
  it('is called by a daemon at start', async () => {
    const port = await freePort();
    const pidFile = pidFileFor(skillDir, port);
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    const deadPid = child.pid!;
    await new Promise<void>((done) => child.on('exit', () => done()));
    await new Promise((r) => setTimeout(r, 50));

    const orphan = join(tmpdir(), captureFileName(deadPid, '0189d8f1-6f1a-7c3a-9b4e-2f7c1d5a8e77'));
    // A capture of this process, which is alive — the control that says the daemon swept on
    // LIVENESS and not on "delete every civitai-test-run file you find".
    const mine = join(
      tmpdir(),
      captureFileName(process.pid, '0189d8f1-6f1a-7c3a-9b4e-2f7c1d5a8e78')
    );

    try {
      writeFileSync(orphan, 'x');
      writeFileSync(mine, 'x');

      const started = await run(cliScript, ['status'], { DEV_DAEMON_PORT: String(port) });
      expect(started.out).not.toMatch(/Failed to start daemon/);

      expect(existsSync(orphan)).toBe(false);
      expect(existsSync(mine)).toBe(true);
    } finally {
      rmSync(orphan, { force: true });
      rmSync(mine, { force: true });
      await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => null);
      for (let i = 0; i < 100 && !(await isDown(port)); i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      rmSync(pidFile, { force: true });
    }
  }, 120_000);
});
