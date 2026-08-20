import { spawn } from 'child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { dirname, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DAEMON_PORT,
  parsePort,
  resolveDaemonPort,
  resolveDaemonUrl,
} from '../../.claude/skills/dev-server/scripts/daemon-port.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillDir = resolve(repoRoot, '.claude/skills/dev-server');
const daemonScript = resolve(skillDir, 'scripts/daemon.mjs');
const cliScript = resolve(skillDir, 'cli.mjs');
const portModule = resolve(skillDir, 'scripts/daemon-port.mjs');
const pidFile = resolve(skillDir, 'daemon.pid');

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
  const res = await fetch(`http://127.0.0.1:${port}/`).catch(() => null);
  return res === null;
}

/**
 * Stop a daemon over its own API and WAIT for it to be gone.
 *
 * The wait is the point, and it is load-bearing rather than tidy. `POST /shutdown` replies 200
 * and only then schedules `unlinkSync(pidFile); process.exit(0)` on a 100 ms timer
 * (daemon.mjs, the /shutdown branch). Returning at the 200 therefore returns ~100 ms BEFORE the
 * unlink, so a caller that restores the developer's pid file at that moment has it deleted out
 * from under them a tick later — which is exactly what this file used to do, on every run of the
 * unit suite.
 */
async function shutdown(port: number) {
  await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' }).catch(() => null);
  for (let i = 0; i < 100; i++) {
    if (await isDown(port)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * The daemon writes its pid into the skill directory, and a developer running this suite has a
 * daemon of their own whose pid file that is. Every case here restores it — after the daemon it
 * started is confirmed gone, never before.
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

describe('parsePort / resolveDaemonPort', () => {
  it('is the default when the variable is unset or empty', () => {
    expect(resolveDaemonPort({})).toBe(9444);
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: '' })).toBe(9444);
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: '   ' })).toBe(9444);
    expect(DEFAULT_DAEMON_PORT).toBe(9444);
  });

  it('honours a numeric value', () => {
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: '9555' })).toBe(9555);
    expect(resolveDaemonPort({ DEV_DAEMON_PORT: ' 9555 ' })).toBe(9555);
    expect(resolveDaemonUrl({ DEV_DAEMON_PORT: '9555' })).toBe('http://127.0.0.1:9555');
    expect(resolveDaemonUrl({})).toBe('http://127.0.0.1:9444');
  });

  // parseInt — what every one of these call sites used to do — reads '9555abc' as 9555 and 'abc'
  // as NaN. NaN reaches a URL as `http://127.0.0.1:NaN` and a listen() as ERR_SOCKET_BAD_PORT,
  // both a long way from the input that was actually wrong.
  it('refuses a value that is not a port instead of guessing one', () => {
    for (const bad of ['abc', '9555abc', '-1', '95.5', '']) {
      expect(() => parsePort(bad, 'X')).toThrow(/X is not a port number/);
    }
    expect(() => parsePort(undefined, 'X')).toThrow(/X is not a port number/);
    // Out of range is a DIFFERENT complaint from unparseable — '0' is a number, just not a port.
    expect(() => parsePort('0', 'X')).toThrow(/X is out of the port range/);
    expect(() => parsePort('70000', 'X')).toThrow(/X is out of the port range/);
  });

  it('names the input in the error, so the message says what to go fix', () => {
    expect(() => resolveDaemonPort({ DEV_DAEMON_PORT: 'nope' })).toThrow(/DEV_DAEMON_PORT/);
    expect(() => parsePort('nope', '--port')).toThrow(/--port/);
  });

  // ON the boundary, not near it. Fixtures of 0 and 70000 leave `65535` free to drift to 65536
  // without any test noticing — measured: that mutant survived the whole suite.
  it('accepts the highest legal port and rejects the first illegal one', () => {
    expect(parsePort('65535', 'X')).toBe(65535);
    expect(parsePort('1', 'X')).toBe(1);
    expect(() => parsePort('65536', 'X')).toThrow(/out of the port range/);
  });
});

/**
 * The PreToolUse hook is a fifth consumer of the port, and until this round it had a sixth copy
 * of the literal. It cannot import the module (it must resolve synchronously, before every Bash
 * command), so it reads the declaration out of the module source — a dependency on that file's
 * formatting, which nothing was testing. Loosening the regex is not a guarantee; this is.
 */
describe('the write-guard hook guards the ports the skill actually uses', () => {
  it('guards the declared default', async () => {
    const { unboundedDevRequest } = await import('../../.claude/hooks/check-writable.mjs');
    expect(unboundedDevRequest(`curl http://localhost:${DEFAULT_DAEMON_PORT}/sessions`)).toHaveLength(1);
    // The negative control: a port the skill does not use must stay silent, or "it guards
    // everything" would read the same as "it guards the right thing".
    expect(unboundedDevRequest('curl http://localhost:7777/sessions')).toHaveLength(0);
  });

  // The override ADDS a daemon beside the shared one; it does not move it. Replacing the default
  // silently un-guarded 9444 for everyone who set the variable — the hook's own selftest went red
  // under DEV_DAEMON_PORT=9555 and nothing in this suite noticed.
  it('guards BOTH the default and an override, because both daemons are live', async () => {
    const { daemonPortsGuarded } = await import('../../.claude/hooks/check-writable.mjs');
    expect(daemonPortsGuarded({}).map(Number)).toEqual([DEFAULT_DAEMON_PORT]);
    expect(daemonPortsGuarded({ DEV_DAEMON_PORT: '9555' }).map(Number).sort()).toEqual(
      [DEFAULT_DAEMON_PORT, 9555].sort()
    );
    // A value that is not a port adds nothing rather than corrupting the pattern.
    expect(daemonPortsGuarded({ DEV_DAEMON_PORT: 'nope' }).map(Number)).toEqual([
      DEFAULT_DAEMON_PORT,
    ]);
    expect(daemonPortsGuarded({ DEV_DAEMON_PORT: '0' }).map(Number)).toEqual([
      DEFAULT_DAEMON_PORT,
    ]);
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
 * `--port` is the HIGHER-precedence input, and it used to be the unvalidated one: `parseInt`
 * turned `--port abc` into NaN. Via cli.mjs the daemon is detached with stdio ignored, so
 * ERR_SOCKET_BAD_PORT is invisible and the user sees only "Failed to start daemon" after a 5 s
 * poll. Validating the environment while argv bypasses the check is not one rule in one place.
 */
describe('argv goes through the same validator as the environment', () => {
  it('rejects a --port that is not a port, naming the flag', async () => {
    const { parseArgs } = await import('../../.claude/skills/dev-server/scripts/daemon.mjs');
    expect(() => parseArgs(['--port', 'abc'])).toThrow(/--port is not a port number/);
    expect(() => parseArgs(['--port'])).toThrow(/--port is not a port number/);
    expect(() => parseArgs(['--port', '70000'])).toThrow(/--port is out of the port range/);
    expect(parseArgs(['--port', '9555']).port).toBe(9555);
  });

  // "argv gets the same validation the environment gets" is a claim about ALL of argv. There are
  // two port flags, and leaving the second on parseInt made that sentence false.
  it('validates --base-dev-port too, not just --port', async () => {
    const { parseArgs } = await import('../../.claude/skills/dev-server/scripts/daemon.mjs');
    expect(() => parseArgs(['--base-dev-port', 'abc'])).toThrow(
      /--base-dev-port is not a port number/
    );
    expect(parseArgs(['--base-dev-port', '3100']).baseDevPort).toBe(3100);
  });

  // The daemon's own header says importing it must not start a daemon; resolving the port at
  // module load would have made a bad DEV_DAEMON_PORT throw on mere import, taking down the
  // suites that import DevSession and the port reservation without intending to run anything.
  it('can be imported with an unusable DEV_DAEMON_PORT without throwing', async () => {
    const code = await new Promise<number | null>((done) => {
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', `await import(${JSON.stringify(daemonScript)});`],
        { cwd: repoRoot, env: { ...process.env, DEV_DAEMON_PORT: 'nope' }, stdio: 'ignore' }
      );
      child.on('exit', done);
    });
    expect(code).toBe(0);
  }, 30_000);
});

/**
 * The ledger. What made this bug possible was several files each deciding the port for
 * themselves, and it is not a bug any of them contains — it is a bug in the SET. console.mjs in
 * particular is a TUI with no end-to-end case here, so a claim about the set is most of what
 * stands between it and a second hardcoded copy.
 *
 * The first version of this scanned a FIXED list of four readers, which could not see the set
 * GROW — and a fifth copy already existed, in `.claude/hooks/check-writable.mjs`, while the test
 * was green. It now walks the tree, so a file that does not exist yet is still covered.
 */
describe('nothing outside daemon-port.mjs decides the daemon port', () => {
  const roots = [skillDir, resolve(repoRoot, 'scripts'), resolve(repoRoot, '.claude/hooks')];

  /** Every .mjs/.js/.ts under the roots, minus node_modules and test files. */
  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
          walk(full);
          continue;
        }
        if (!/\.(mjs|cjs|js|ts)$/.test(entry.name)) continue;
        // Test files legitimately pin the expected default as a literal — a test that derived
        // its expectation from the implementation would assert nothing.
        if (/\.(test|spec|selftest)\./.test(entry.name)) continue;
        out.push(full);
      }
    };
    roots.forEach(walk);
    return out;
  }

  it('finds the files it claims to scan', () => {
    // The positive control. Without it a typo in `roots` yields an empty set, every assertion
    // below passes vacuously, and "no second copy anywhere" would be a fact about the walk.
    const files = sourceFiles().map((f) => relative(repoRoot, f));
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('.claude/skills/dev-server/cli.mjs');
    expect(files).toContain('.claude/skills/dev-server/console.mjs');
    expect(files).toContain('.claude/skills/dev-server/scripts/daemon.mjs');
    expect(files).toContain('.claude/hooks/check-writable.mjs');
    expect(files).toContain('scripts/test-unit-run.mjs');
  });

  it('spells the port in exactly one source file', () => {
    // \b so 19444 and 94440 are not counted as a copy of 9444.
    const literal = new RegExp(String.raw`\b${DEFAULT_DAEMON_PORT}\b`);
    const owner = relative(repoRoot, portModule);

    const holders = sourceFiles()
      .filter((f) => literal.test(readFileSync(f, 'utf8')))
      .map((f) => relative(repoRoot, f))
      .sort();

    expect(holders).toEqual([owner]);
  });

  it('has every daemon client take its address from that module', () => {
    const clients = [cliScript, resolve(skillDir, 'console.mjs')];
    for (const file of clients) {
      const source = readFileSync(file, 'utf8');
      const name = relative(repoRoot, file);
      // An IMPORT, not a mention: `includes('daemon-port.mjs')` alone is satisfied by a comment,
      // and this file's prose names the module in several of them.
      expect(`${name}: ${/^import .*from '.*daemon-port\.mjs';$/m.test(source)}`).toBe(
        `${name}: true`
      );
      // The client takes the whole URL. Resolving a PORT and then doing arithmetic on it is the
      // shape that let a wrong-but-non-literal value through: `resolveDaemonPort() + 1` used to
      // satisfy every assertion here.
      expect(`${name}: ${/const DAEMON_URL = resolveDaemonUrl\(\);/.test(source)}`).toBe(
        `${name}: true`
      );
    }
  });
});

/**
 * console.mjs, behaviourally — the residual of the "ledger is spelled, not structural" finding.
 *
 * Every structural assertion available is walkable by a mutant that resolves the URL correctly
 * and then drifts it: `resolveDaemonUrl().replace(/\d+$/, n => Number(n) + 1)` passes the import
 * check and the call check both. Only asking the socket which port it was actually asked for
 * settles it, so this stands a stub daemon up and reads the request that arrives.
 */
describe('the console talks to the port it resolved', () => {
  it('sends its first request to the port DEV_DAEMON_PORT names', async () => {
    const consoleScript = resolve(skillDir, 'console.mjs');
    const hits: string[] = [];

    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessions: [], runs: [] }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;

    // `--tail`, because the dashboard refuses to start without a TTY ("Dashboard requires a TTY
    // terminal") and exits 1 before it ever contacts the daemon. --tail is its own documented
    // non-interactive mode and goes through the same resolved DAEMON_URL.
    const child = spawn(process.execPath, [consoleScript, '--tail'], {
      cwd: repoRoot,
      env: { ...process.env, DEV_DAEMON_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.resume();

    try {
      for (let i = 0; i < 100 && hits.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      child.kill('SIGKILL');
      await new Promise<void>((done) => server.close(() => done()));
    }

    // A stub on a port nothing else knows about. A request arriving here at all is proof the
    // console resolved THIS port — an off-by-one would have gone somewhere else and hit nothing.
    expect(hits.length).toBeGreaterThan(0);
  }, 60_000);
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

  // The bug this file shipped in its first version: the restore raced the daemon's own unlink,
  // so running the unit suite deleted the developer's daemon.pid and it never came back.
  it('leaves the pid file exactly as it found it', async () => {
    const port = await freePort();
    const sentinel = String(Date.now());
    const had = existsSync(pidFile);
    const saved = had ? readFileSync(pidFile) : null;

    try {
      writeFileSync(pidFile, sentinel);
      await withPidFilePreserved(async () => {
        await new Promise<void>((done) => {
          const child = spawn(process.execPath, [cliScript, 'status'], {
            cwd: repoRoot,
            env: { ...process.env, DEV_DAEMON_PORT: String(port) },
            stdio: 'ignore',
          });
          child.on('exit', () => done());
        });
        await shutdown(port);
      });

      // Long enough to cover the daemon's 100 ms post-response unlink timer several times over.
      await new Promise((r) => setTimeout(r, 600));
      expect(existsSync(pidFile)).toBe(true);
      expect(readFileSync(pidFile, 'utf8')).toBe(sentinel);
    } finally {
      if (saved) writeFileSync(pidFile, saved);
      else rmSync(pidFile, { force: true });
    }
  }, 60_000);
});

/**
 * `scripts/test-unit-run.mjs` promises, in its own comment, never to leave a caller unable to
 * run tests because the queue is unavailable. Resolving the address can now THROW, and an
 * unusable address is the queue being unavailable — so it has to degrade the same way. It did
 * not: the throw escaped an un-awaited runQueued as an unhandled rejection and no tests ran.
 */
describe('an unusable DEV_DAEMON_PORT still runs the tests', () => {
  it('falls back to a direct run instead of dying', async () => {
    const script = resolve(repoRoot, 'scripts/test-unit-run.mjs');

    const stderr = await new Promise<string>((done) => {
      const child = spawn(process.execPath, [script], {
        cwd: repoRoot,
        env: {
          ...process.env,
          CI: '',
          CIVITAI_TEST_QUEUE: '1',
          DEV_DAEMON_PORT: 'nope',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      const finish = () => {
        child.kill('SIGKILL');
        done(buf);
      };
      // The fallback is a REAL vitest run of the whole suite, so the moment the decision is
      // observable the child is killed. Waiting for it to finish would run the suite recursively.
      child.stderr.on('data', (d: Buffer) => {
        buf += d.toString();
        if (/running directly/i.test(buf)) finish();
      });
      child.stdout.resume();
      child.on('exit', () => done(buf));
      setTimeout(finish, 25_000);
    });

    // The SPECIFIC message, not just "running directly". There are two guards on this path — the
    // targeted catch around address resolution, and a general `.catch()` on the un-awaited
    // runQueued — and the general one also degrades to a direct run. Asserting the generic phrase
    // was satisfied by whichever fired, so deleting the targeted guard left the suite green
    // (measured: it survived the mutation battery). Naming the message pins which one ran.
    expect(stderr).toMatch(/Test queue address unusable/);
    expect(stderr).toMatch(/running directly/i);
    expect(stderr).not.toMatch(/UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/);
  }, 40_000);

  /**
   * The other half of that guarantee, and the direction it must NOT go.
   *
   * Once the daemon has accepted the run it owns a slot for it. Degrading to a direct run at that
   * point starts a second, unqueued full suite beside the queued one — defeating the serialisation
   * the script exists to provide. The fix round's first attempt wrapped the whole lifecycle in one
   * catch and did exactly that: a socket dropped mid-poll printed "running directly" and started
   * vitest.
   */
  it('does NOT start a second suite once the queue has accepted the run', async () => {
    const script = resolve(repoRoot, 'scripts/test-unit-run.mjs');

    // A daemon that accepts the run and then dies, which is the shape that used to double-run.
    let sockets: import('net').Socket[] = [];
    const server = createServer((req, res) => {
      if (req.url === '/test-runs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'stub', status: 'queued', position: 1, queueLength: 1 }));
        return;
      }
      // The poll: drop the connection rather than answer.
      req.socket.destroy();
    });
    server.on('connection', (s) => sockets.push(s));
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;

    const out = await new Promise<{ code: number | null; text: string }>((done) => {
      const child = spawn(process.execPath, [script], {
        cwd: repoRoot,
        env: { ...process.env, CI: '', CIVITAI_TEST_QUEUE: '1', DEV_DAEMON_PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let text = '';
      child.stdout.on('data', (d: Buffer) => (text += d.toString()));
      child.stderr.on('data', (d: Buffer) => (text += d.toString()));
      const bail = setTimeout(() => child.kill('SIGKILL'), 25_000);
      child.on('exit', (code) => {
        clearTimeout(bail);
        done({ code, text });
      });
    });

    sockets.forEach((s) => s.destroy());
    await new Promise<void>((done) => server.close(() => done()));

    expect(out.text).toMatch(/Queued at position/);
    // The tell that the bug is back would be a vitest banner in this output.
    expect(out.text).not.toMatch(/running directly/i);
    expect(out.text).not.toMatch(/RUN\s+v\d/);
    expect(out.code).toBe(2);
  }, 40_000);

  it('does not hold a stale port module reference', () => {
    // The module the script reaches for must actually be there; the script gates on existsSync
    // and would silently take the direct path forever if this moved.
    expect(existsSync(portModule)).toBe(true);
    expect(statSync(portModule).size).toBeGreaterThan(0);
    expect(readFileSync(resolve(repoRoot, 'scripts/test-unit-run.mjs'), 'utf8')).toContain(
      'daemon-port.mjs'
    );
  });
});
