import type * as ChildProcess from 'child_process';
import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Nothing in this file may reach a real process. The mock is on the module rather than on
// DevSession.killProcessTree so that reverting the daemon's kill path back inline cannot make
// these tests fire a real `taskkill` at whatever owns pid 4242 today.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: spawnMock,
}));

const isPortFreeMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../.claude/skills/dev-server/scripts/port-probe.mjs', () => ({
  isPortFree: isPortFreeMock,
}));

// The daemon ships with the dev-server skill (plain .mjs, run by node, never bundled), so it is
// imported by path the way its port probe already is. Importing it does not start a daemon —
// `main()` runs only when the file is the entry point.
import {
  claimPortForReuse,
  DevSession,
  findSessionByWorktree,
  getUsedPorts,
  sessions,
} from '../../.claude/skills/dev-server/scripts/daemon.mjs';

// Short waits so a test that must observe the wait does not spend the real 8s doing it, and a
// scan base above the default 3000 so these cases cannot be satisfied by a port a real session
// would be using.
const FAST_CLAIM = { timeoutMs: 60, intervalMs: 10, baseDevPort: 3100 };

const ENV_PATH = '/nonexistent/.env'; // only read by start(), which no test here calls

afterEach(() => {
  sessions.clear();
  // restoreAllMocks does not undo the module mocks (they are not spies), so both are reset
  // explicitly; it is kept so the next spyOn written without a finally cannot leak.
  vi.restoreAllMocks();
  spawnMock.mockClear();
  isPortFreeMock.mockReset();
  isPortFreeMock.mockResolvedValue(true);
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

    expect(await claimPortForReuse(session, FAST_CLAIM)).toBe(3102);
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

    expect(await claimPortForReuse(session, FAST_CLAIM)).toBe(3103);
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

  // Two starts can interleave — a branch switch restarting while a request takes the session
  // over. Without this the loser keeps running, unreachable and holding the port, for the
  // daemon's lifetime, and the exit guard then discards even its exit.
  it('kills a process still attached before replacing it', () => {
    const session = makeSession('replacing', 3121);
    const doomed = fakeProcess(6161);
    session.process = doomed;

    session.detachRunningProcess();

    expect(session.process).toBe(null);
    if (process.platform === 'win32') {
      expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/pid', '6161', '/f', '/t'], {
        shell: true,
      });
    }
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
        });
      } else {
        expect(killSpy).toHaveBeenCalledWith(-31337, 'SIGKILL');
      }
    } finally {
      killSpy.mockRestore();
    }
  });
});
