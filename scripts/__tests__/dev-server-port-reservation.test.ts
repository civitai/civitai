import { EventEmitter } from 'events';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The daemon ships with the dev-server skill (plain .mjs, run by node, never bundled), so it is
// imported by path the way its port probe already is. Importing it does not start a daemon —
// `main()` runs only when the file is the entry point.
import {
  DevSession,
  getUsedPorts,
  sessions,
} from '../../.claude/skills/dev-server/scripts/daemon.mjs';

const ENV_PATH = '/nonexistent/.env'; // only read by start(), which no test here calls

afterEach(() => {
  sessions.clear();
  vi.restoreAllMocks();
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
  session.killProcessTree = vi.fn();
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
    expect(session.killProcessTree).toHaveBeenCalledTimes(1);
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
});
