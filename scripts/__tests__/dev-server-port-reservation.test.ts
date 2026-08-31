import type * as ChildProcess from 'child_process';
import type * as FsPromises from 'fs/promises';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Nothing in this file may reach a real process. The mock is on the module rather than on
// DevSession.killProcessTree so that reverting the daemon's kill path back inline cannot make
// these tests fire a real `taskkill` at whatever owns pid 4242 today.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock,
}));

const accessMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  access: accessMock,
}));

const isPortFreeMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../.claude/skills/dev-server/scripts/port-probe.mjs', () => ({
  isPortFree: isPortFreeMock,
}));

// The daemon ships with the dev-server skill (plain .mjs, run by node, never bundled), so it is
// imported by path the way its port probe already is. Importing it does not start a daemon —
// `main()` runs only when the file is the entry point.
import {
  checkPath,
  claimPortForReuse,
  DevSession,
  findSessionByWorktree,
  getUsedPorts,
  listSessions,
  sessionIsBusy,
  sessions,
} from '../../.claude/skills/dev-server/scripts/daemon.mjs';

// A 1ms poll with a generous deadline keeps the cases where the port FREES count-bound rather than
// clock-bound: the probe mocks decide the outcome, so a slow box cannot turn a pass into the very
// failure these tests exist to detect. The scan base sits above the default 3000 so no case can be
// satisfied by a port a real session would be using.
const FAST_CLAIM = { timeoutMs: 5000, intervalMs: 1, baseDevPort: 3100 };

// The cases where the port NEVER frees are a different shape, and the comment above used to claim
// them too. They cannot be count-bound: claimPortForReuse polls until its deadline and only then
// moves, so expiry IS the mechanism under test and the deadline is paid in full. At 5000ms the two
// of them cost 10.0s of the file's 10.6s — measured, and unmoved by running the file alone, which
// is what distinguishes a real wait from contention. 60ms buys the same expiry.
//
// Shortening it cannot make these flaky: the assertion is that the session MOVED, and the move is
// what happens once the deadline passes however few probes fit inside it.
const HELD_CLAIM = { ...FAST_CLAIM, timeoutMs: 60 };

const ENV_PATH = '/nonexistent/.env'; // only read by start(), which no test here calls

afterEach(() => {
  sessions.clear();
  // restoreAllMocks does not undo the module mocks (they are not spies), so both are reset
  // explicitly; it is kept so the next spyOn written without a finally cannot leak.
  vi.restoreAllMocks();
  spawnMock.mockClear();
  isPortFreeMock.mockReset();
  isPortFreeMock.mockResolvedValue(true);
  accessMock.mockReset();
  accessMock.mockResolvedValue(undefined);
});

function makeSession(id: string, port: number) {
  const session = new DevSession(id, tmpdir(), port, ENV_PATH);
  sessions.set(id, session);
  return session;
}

// A child process stand-in. It emits only what a test emits, so nothing here can outlive the
// test or drive a loop of its own.
function fakeProcess(pid = 4242) {
  const proc = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.pid = pid;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  return proc;
}

function wire(session: ReturnType<typeof makeSession>, proc: ReturnType<typeof fakeProcess>) {
  session.process = proc;
  session.attachProcessHandlers(proc);
  return proc;
}

describe('dev-server port reservation', () => {
  // The negative control: without it, a getUsedPorts hardwired to reserve every port in the
  // range would pass every case below.
  it('reserves nothing when no session is tracked', () => {
    expect([...getUsedPorts()]).toEqual([]);
  });

  // The bug. `crashed` is a report about a process the daemon cannot see into, and it has been
  // written for a session whose process was alive and holding its port.
  it('reserves the port of a session marked crashed', () => {
    makeSession('crashed-one', 3011).status = 'crashed';
    expect([...getUsedPorts()]).toEqual([3011]);
  });

  it.each(['starting', 'running', 'crashed', 'error', 'stopped'])(
    'reserves the port of a session in status %s',
    (status) => {
      makeSession(`s-${status}`, 3021).status = status;
      expect(getUsedPorts().has(3021)).toBe(true);
    }
  );

  // The release path. `cli stop <id>` sends DELETE /sessions/:id, which removes the session from
  // this map — so if removal did not release the port, a stopped session would strand it.
  it('releases the port when the session is no longer tracked', () => {
    const session = makeSession('gone', 3031);
    expect(getUsedPorts().has(3031)).toBe(true);

    sessions.delete(session.id);
    expect(getUsedPorts().has(3031)).toBe(false);
  });
});

describe('dev-server port claim on reuse', () => {
  it('keeps the port when nothing else holds it', async () => {
    const session = makeSession('free', 3101);

    expect(await claimPortForReuse(session, FAST_CLAIM)).toBe(3101);
    expect(session.port).toBe(3101);
  });

  // The measured case, and the one that makes this dangerous: a killed listener on this box
  // released its socket 630-668ms after taskkill was spawned, while stop() waits at most 500ms.
  // So the session's OWN dying process reads as busy on the first probe of every restart, and
  // moving on that reading takes a healthy session off its port — which for the primary session
  // unhooks the rgb-proxy (hardcoded to 3000) and rewrites its auth URLs, silently.
  it('waits out its own process still dying rather than moving', async () => {
    const session = makeSession('dying', 3101);
    let probes = 0;
    isPortFreeMock.mockImplementation(async () => ++probes > 3);

    expect(await claimPortForReuse(session, FAST_CLAIM)).toBe(3101);
    expect(session.port).toBe(3101);
    expect(probes).toBeGreaterThan(1);
  });

  // `next dev` does not fail on an occupied port, it warns and moves. So restarting a session
  // onto a port an orphan still holds gives a session whose reported url and health check both
  // point at a server it does not own.
  it('moves the session off a port that stays held', async () => {
    const session = makeSession('held', 3101);
    makeSession('neighbour', 3100).status = 'running';
    isPortFreeMock.mockImplementation(async (port: number) => port !== 3101);

    expect(await claimPortForReuse(session, HELD_CLAIM)).toBe(3102);
    expect(session.port).toBe(3102);
    expect(session.logs.at(-1)?.message).toContain('moving this session to 3102');
  });

  // The replacement must respect the other sessions' reservations, or taking one session over
  // would land it on a port another worktree owns.
  it('skips ports reserved by other sessions when it moves', async () => {
    const session = makeSession('held', 3101);
    makeSession('below', 3100).status = 'running';
    makeSession('above', 3102).status = 'crashed';
    isPortFreeMock.mockImplementation(async (port: number) => port !== 3101);

    expect(await claimPortForReuse(session, HELD_CLAIM)).toBe(3103);
  });
});

describe('dev-server restart wiring', () => {
  // The whole reason the probe means anything: run it before the stop and it sees the session's
  // own live server; run it after the start and the session is already on the port. Between the
  // two is the only moment it says something about anyone else.
  it('claims the port after stopping and before starting', async () => {
    const session = makeSession('ordered', 3111);
    const proc = wire(session, fakeProcess(5150));
    const order: string[] = [];

    session.start = vi.fn(async () => {
      order.push('start');
      return session.getStatus();
    });
    const stopping = session.restart(async () => {
      order.push(session.process ? 'claim-before-stop' : 'claim-after-stop');
    });
    proc.emit('exit', 1, 'SIGKILL');
    await stopping;

    expect(order).toEqual(['claim-after-stop', 'start']);
  });

  // Two restarts overlapping would have the second probe the port the first had just bound, read
  // it as taken, and move the session off a port it had only just been given.
  it('serializes overlapping restarts', async () => {
    const session = makeSession('serial', 3141);
    const order: string[] = [];
    let releaseFirst: (() => void) | null = null;

    session.start = vi.fn(async () => session.getStatus());
    const first = session.restart(async () => {
      order.push('first-in');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push('first-out');
    });
    const second = session.restart(async () => {
      order.push('second-in');
    });

    // The lock defers through a promise chain, so let the queue drain before reading it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(['first-in']);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual(['first-in', 'first-out', 'second-in']);
  });

  // A session removed while a branch switch was mid-install would otherwise reach its start and
  // spawn a dev server nothing tracks, on a port nothing reserves.
  it('refuses to start a session that has been removed', async () => {
    const session = makeSession('removed', 3151);
    session.removed = true;

    // Returns a usable stand-in, so a start that wrongly proceeds fails on the assertion below
    // rather than on a mock that handed it undefined.
    spawnMock.mockImplementation(() => fakeProcess(7171));

    await session.start();

    expect(spawnMock).not.toHaveBeenCalled();
    expect(session.process).toBe(null);
  });

  // Two starts can interleave — a branch switch restarting while a request takes the session
  // over. Without this the loser keeps running, unreachable and holding the port, for the
  // daemon's lifetime, and the exit guard then discards even its exit.
  it('kills a process still attached before replacing it', () => {
    const session = makeSession('replacing', 3121);
    session.process = fakeProcess(6161);
    // The module-level spawn mock only covers the win32 branch. Off Windows the kill is
    // `process.kill(-pid)`, and CI runs this suite as root, so an unspied call would send a real
    // SIGKILL to whatever holds process group 6161 in the container.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      session.detachRunningProcess();

      expect(session.process).toBe(null);
      if (process.platform === 'win32') {
        expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '6161', '/f', '/t'], {
          shell: true,
          windowsHide: true,
        });
      } else {
        expect(killSpy).toHaveBeenCalledWith(-6161, 'SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('dev-server session busy reporting', () => {
  // A restart waiting out its port reads `stopped` with no process for as long as the wait lasts,
  // and a start that seems to hang is exactly what makes an agent run it again. Reporting the
  // session as busy is what stops that second call booting a competing server.
  it.each([
    ['a running session', { status: 'running' }],
    ['a starting session', { status: 'starting' }],
    ['a session mid branch switch', { status: 'stopped', switching: true }],
    ['a session waiting on its own restart', { status: 'stopped', busyDepth: 1 }],
  ])('reports %s as busy', (_label, state) => {
    const session = makeSession(`busy-${_label}`, 3161);
    Object.assign(session, state);

    expect(sessionIsBusy(session)).toBe(true);
  });

  // The cases above set the flag by hand, so they pin how it is read and nothing about how it is
  // maintained. With a plain boolean the first queued op's clear runs before the second op's body,
  // so the session reads idle while a restart is still running — it fails in exactly the pile-up
  // the flag exists for, and every hand-set case stays green.
  it('still reports busy while a second queued restart is running', async () => {
    const session = makeSession('queued', 3163);
    session.status = 'stopped';
    const seen: boolean[] = [];
    let releaseFirst: (() => void) | null = null;

    session.start = vi.fn(async () => session.getStatus());
    const first = session.restart(async () => {
      seen.push(sessionIsBusy(session));
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const second = session.restart(async () => {
      seen.push(sessionIsBusy(session));
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(seen).toEqual([true, true]);
    expect(sessionIsBusy(session)).toBe(false);
  });

  // The negative control. Without it, a predicate hardwired to true would pass every case above
  // and no session could ever be taken over.
  it('reports a plain dead session as free to take over', () => {
    const session = makeSession('idle', 3162);
    session.status = 'crashed';

    expect(sessionIsBusy(session)).toBe(false);
  });
});

describe('dev-server worktree checks', () => {
  // Racing a timeout bounds the caller's wait, not the libuv slot the loser keeps — so without
  // dedupe the TUI polling twice a second injects two 21s jobs per second into a four-slot pool
  // and it never drains. One probe in flight per path is what actually bounds it.
  it('runs one probe at a time for a path', async () => {
    accessMock.mockImplementation(() => new Promise(() => undefined));

    const first = checkPath('/slow/worktree');
    const second = checkPath('/slow/worktree');

    expect(await first).toEqual({ exists: true, timedOut: true });
    expect(await second).toEqual({ exists: true, timedOut: true });
    expect(accessMock).toHaveBeenCalledTimes(1);
  });

  // Slow is not evidence of deletion, and calling a live worktree missing is the more damaging
  // wrong answer — but the caller is told the check never landed, so a listing can say "could not
  // tell" instead of "fine".
  it('reports a worktree that will not answer as present, and says so', async () => {
    accessMock.mockImplementation(() => new Promise(() => undefined));

    expect(await checkPath('/unreachable/worktree')).toEqual({ exists: true, timedOut: true });
  });

  it('reports a missing worktree as missing', async () => {
    accessMock.mockRejectedValue(new Error('ENOENT'));

    expect(await checkPath('/deleted/worktree')).toEqual({ exists: false, timedOut: false });
  });

  // A miss is never slow, so caching one protects nothing and makes a worktree created seconds
  // after a failed start read as still missing — with an error naming the path, which sends the
  // reader after the wrong thing entirely.
  it('re-probes a path that was missing rather than trusting the last answer', async () => {
    accessMock.mockRejectedValueOnce(new Error('ENOENT'));
    expect(await checkPath('/worktree/created/late')).toEqual({ exists: false, timedOut: false });

    accessMock.mockResolvedValue(undefined);
    expect(await checkPath('/worktree/created/late')).toEqual({ exists: true, timedOut: false });
  });

  // The other half: a settled hit IS reused, which is what collapses the TUI's twice-a-second
  // polling into one probe.
  it('reuses a settled hit within the cache window', async () => {
    expect(await checkPath('/worktree/present')).toEqual({ exists: true, timedOut: false });
    expect(await checkPath('/worktree/present')).toEqual({ exists: true, timedOut: false });

    expect(accessMock).toHaveBeenCalledTimes(1);
  });
});

describe('dev-server session listing', () => {
  // Where someone hunting a permanently-reserved port actually looks: a session whose worktree has
  // been deleted still holds its port and can never be started again.
  it('marks a session whose worktree is gone', async () => {
    const gone = resolve(tmpdir(), 'wt-that-does-not-exist');
    makeSession('present', 3171);
    makeSession('vanished', 3172).worktree = gone;
    accessMock.mockImplementation(async (path: string) => {
      if (path === gone) throw new Error('ENOENT');
    });

    const listed = await listSessions();

    expect(listed.find((s) => s.id === 'present')?.worktreeMissing).toBe(false);
    expect(listed.find((s) => s.id === 'vanished')?.worktreeMissing).toBe(true);
  });
});

describe('dev-server worktree matching', () => {
  // worktree.mjs compares these case-insensitively. If the daemon does not, `cli start c:/dev/...`
  // after a session created as `C:\Dev\...` gives that one tree two sessions, two dev servers and
  // two permanently-reserved ports.
  // Windows is spoofed rather than skipped so this still guards the behaviour on a Linux CI box,
  // where the case fold would otherwise never be exercised at all.
  it('matches a worktree path that differs only in case', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const session = makeSession('cased', 3131);
      session.worktree = '/Dev/Repos/work/wt-example';

      expect(findSessionByWorktree('/dev/repos/work/wt-example')).toBe(session);
    } finally {
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('does not match a different worktree', () => {
    makeSession('other', 3132).worktree = '/Dev/Repos/work/wt-example';

    expect(findSessionByWorktree('/Dev/Repos/work/wt-different')).toBe(null);
  });
});

describe('dev-server session process lifecycle', () => {
  // stop() hard-kills, so the process exits nonzero. Reading the outcome off that exit code
  // filed every deliberate stop as a crash, which is most of what made `crashed` untrustworthy.
  it('records a deliberate stop as stopped, not crashed', async () => {
    const session = makeSession('deliberate', 3041);
    const proc = wire(session, fakeProcess());
    session.status = 'running';

    const stopping = session.stop();
    proc.emit('exit', 1, 'SIGKILL');
    await stopping;

    expect(session.status).toBe('stopped');
    expect(session.process).toBe(null);
  });

  // The other half of that: an exit nobody asked for must still read as a crash, or the fix
  // above would be indistinguishable from deleting crash reporting altogether.
  it('records an unprompted nonzero exit as crashed', () => {
    const session = makeSession('genuine', 3051);
    const proc = wire(session, fakeProcess());
    session.status = 'running';

    proc.emit('exit', 1, null);

    expect(session.status).toBe('crashed');
    expect(session.exitCode).toBe(1);
    expect(getUsedPorts().has(3051)).toBe(true);
  });

  it('records a clean exit as stopped', () => {
    const session = makeSession('clean', 3061);
    const proc = wire(session, fakeProcess());
    session.status = 'running';

    proc.emit('exit', 0, null);

    expect(session.status).toBe('stopped');
  });

  // A failed spawn is not a clean shutdown, and stopping a session that never had a process
  // must not rewrite that.
  it('leaves an errored session reporting error when stopped', async () => {
    const session = makeSession('errored', 3062);
    session.status = 'error';

    await session.stop();

    expect(session.status).toBe('error');
  });

  // A restart replaces the process. The old one exits afterwards, and before the identity guard
  // that late exit marked the live session crashed — the exact state that then lost its port.
  it('ignores the exit of a process the session has already replaced', () => {
    const session = makeSession('replaced', 3071);
    const old = wire(session, fakeProcess(1111));
    const fresh = wire(session, fakeProcess(2222));
    session.status = 'running';

    old.emit('exit', 1, 'SIGKILL');

    expect(session.status).toBe('running');
    expect(session.process).toBe(fresh);
  });

  it('ignores a spawn error from a process the session has already replaced', () => {
    const session = makeSession('replaced-error', 3081);
    const old = wire(session, fakeProcess(1111));
    wire(session, fakeProcess(2222));
    session.status = 'running';

    old.emit('error', new Error('spawn ENOENT'));

    expect(session.status).toBe('running');
  });

  it('kills the tracked process rather than any other', () => {
    const session = makeSession('killer', 3091);
    const proc = fakeProcess(31337);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    try {
      session.killProcessTree(proc);

      if (process.platform === 'win32') {
        expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '31337', '/f', '/t'], {
          shell: true,
          windowsHide: true,
        });
      } else {
        expect(killSpy).toHaveBeenCalledWith(-31337, 'SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
