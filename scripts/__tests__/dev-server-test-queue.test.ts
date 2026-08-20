import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ships with the dev-server skill (plain .mjs, loaded by the daemon under node, never bundled),
// so it is imported by path rather than moved into src/ — same arrangement as the port probe.
import { TestQueue, exitCodeFor } from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

type FakeRun = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  finish: (code: number) => void;
  worktree: string;
};

// Every fake terminates on demand and nothing here drives a loop: the queue owns no timers, so
// each deadline is reached by moving the injected clock. A regression fails on an assertion
// naming the wrong position or status, never by hanging the runner.
type RunnerArgs = { worktree: string; onExit?: (code: number, error?: string) => void };

function makeRunner() {
  const started: FakeRun[] = [];
  const startRun = ({ worktree }: RunnerArgs): FakeRun => {
    const handle = new EventEmitter() as FakeRun;
    handle.kill = vi.fn(() => handle.emit('exit', 1));
    handle.finish = (code: number) => handle.emit('exit', code);
    handle.worktree = worktree;
    started.push(handle);
    return handle;
  };
  return { started, startRun };
}

describe('dev-server test queue', () => {
  let now: number;
  let runner: ReturnType<typeof makeRunner>;

  const build = (overrides = {}) =>
    new TestQueue({
      // Indirect so a test can swap the runner after construction.
      startRun: (opts: RunnerArgs) => runner.startRun(opts),
      now: () => now,
      abandonAfterMs: 10_000,
      runTimeoutMs: 60_000,
      ...overrides,
    });

  beforeEach(() => {
    now = 1_000;
    runner = makeRunner();
  });

  it('runs the first request immediately and queues the rest with exact positions', () => {
    const queue = build();

    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });
    const third = queue.request({ worktree: '/wt/c' });

    expect(first.status).toBe('running');
    expect(first.position).toBe(0);
    expect(second.status).toBe('queued');
    expect(second.position).toBe(1);
    expect(third.position).toBe(2);
    expect(runner.started).toHaveLength(1);
  });

  it('starts the next run when the running one exits, and reports the outcome', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    runner.started[0].finish(0);

    expect(queue.get(first.id).status).toBe('completed');
    expect(queue.get(first.id).exitCode).toBe(0);
    expect(queue.get(second.id).status).toBe('running');
    expect(queue.get(second.id).position).toBe(0);
    expect(runner.started).toHaveLength(2);
  });

  it('reports a nonzero exit as failed and still frees the slot', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    runner.started[0].finish(1);

    expect(queue.get(first.id).status).toBe('failed');
    expect(queue.get(first.id).exitCode).toBe(1);
    expect(queue.get(second.id).status).toBe('running');
  });

  it('honours a configured concurrency above one', () => {
    const queue = build({ concurrency: 2 });

    queue.request({ worktree: '/wt/a' });
    queue.request({ worktree: '/wt/b' });
    const third = queue.request({ worktree: '/wt/c' });

    expect(runner.started).toHaveLength(2);
    expect(third.status).toBe('queued');
    expect(third.position).toBe(1);
  });

  it('treats concurrency 0 as paused, and says so rather than leaving the caller guessing', () => {
    const queue = build({ concurrency: 0 });

    const run = queue.request({ worktree: '/wt/a' });

    expect(run.status).toBe('queued');
    expect(run.paused).toBe(true);
    expect(run.position).toBe(1);
    expect(runner.started).toHaveLength(0);

    queue.setConcurrency(1);

    expect(queue.get(run.id).status).toBe('running');
    expect(queue.get(run.id).paused).toBe(false);
  });

  it('rejects a negative concurrency instead of quietly clamping it', () => {
    expect(() => build({ concurrency: -1 })).toThrow(/concurrency must be an integer/);
  });

  it('drops a queued run whose caller stopped polling, and starts the one behind it', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const abandoned = queue.request({ worktree: '/wt/b' });
    const behind = queue.request({ worktree: '/wt/c' });

    // The caller of `behind` is alive and polling; the caller of `abandoned` died.
    now += 9_000;
    queue.get(behind.id);
    now += 2_000;

    const swept = queue.sweep();

    expect(swept.abandoned).toEqual([abandoned.id]);
    expect(queue.get(abandoned.id).status).toBe('abandoned');
    expect(queue.get(behind.id).status).toBe('queued');
    expect(queue.get(behind.id).position).toBe(1);
    expect(queue.get(first.id).status).toBe('running');
  });

  it('never abandons a run that is already executing — the daemon owns it, not the caller', () => {
    const queue = build({ concurrency: 2 });
    const executing = queue.request({ worktree: '/wt/a' });
    queue.request({ worktree: '/wt/b' });
    const waiting = queue.request({ worktree: '/wt/c' });

    now += 30_000; // three times the abandon window, half the run ceiling
    const swept = queue.sweep();

    // The queued sibling proves the sweep ran and was capable of abandoning something; without it
    // an empty `abandoned` list would be true no matter what the sweep did.
    expect(swept.abandoned).toEqual([waiting.id]);
    expect(queue.get(executing.id).status).toBe('running');
  });

  it('kills a run that overruns the ceiling and hands the slot to the next caller', () => {
    const queue = build();
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    // `next` has a live waiter polling it, which is what keeps it out of the abandon sweep during
    // a long run ahead of it.
    for (let elapsed = 5_000; elapsed <= 55_000; elapsed += 5_000) {
      now += 5_000;
      queue.get(next.id);
      expect(queue.sweep().timedOut).toEqual([]);
    }
    now += 5_001;

    const swept = queue.sweep();

    expect(swept.timedOut).toEqual([stuck.id]);
    expect(runner.started[0].kill).toHaveBeenCalledTimes(1);
    expect(queue.get(stuck.id).status).toBe('timeout');
    expect(queue.get(next.id).status).toBe('running');
  });

  it('frees the slot when a killed process never exits, rather than holding it forever', () => {
    const queue = build({ killGraceMs: 5_000 });
    // A process that swallows the kill — the wedge this whole queue exists to prevent.
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    now += 60_001;
    queue.get(next.id);
    expect(queue.sweep().timedOut).toEqual([stuck.id]);
    expect(queue.get(stuck.id).status).toBe('running'); // kill issued, exit not seen yet
    expect(queue.get(next.id).status).toBe('queued');

    now += 5_000;
    const swept = queue.sweep();

    expect(swept.forced).toEqual([stuck.id]);
    expect(queue.get(stuck.id).status).toBe('timeout');
    expect(queue.get(stuck.id).error).toMatch(/did not exit after kill/);
    expect(queue.get(next.id).status).toBe('running');
  });

  /**
   * The two paths where a run's own 'exit' never arrives are exactly the two that must still
   * release what the run owns. A real handle owns a capture file, two descriptors and a tail
   * interval, and `finish` is bound to that 'exit' — so dropping `run.handle` here without a
   * dispose left all three alive forever. Measured before the fix, on a forced run: 2 fds still
   * open and the log still growing 2s after the run was reported terminal (logIndex 75 -> 471),
   * the file at 102,465 bytes and never unlinked.
   *
   * Asserted on the QUEUE rather than on the handle: a `dispose()` that exists and is never
   * called is exactly the shape this missed the first time.
   */
  it('disposes a handle whose process never exits, on both release paths', () => {
    const disposals: string[] = [];
    const stubborn = (tag: string) => (): FakeRun => {
      const handle = new EventEmitter() as FakeRun & { dispose: () => void };
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = '/wt';
      handle.dispose = vi.fn(() => disposals.push(tag));
      runner.started.push(handle);
      return handle;
    };

    // Path 1 — the sweep's force-release past the kill grace.
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = stubborn('forced');
    const stuck = queue.request({ worktree: '/wt/a' });
    now += 60_001;
    queue.sweep();
    now += 5_000;
    expect(queue.sweep().forced).toEqual([stuck.id]);
    expect(disposals).toEqual(['forced']);

    // Path 2 — daemon shutdown, which exits the process immediately afterwards.
    const queue2 = build();
    runner.startRun = stubborn('shutdown');
    queue2.request({ worktree: '/wt/b' });
    queue2.shutdown();
    expect(disposals).toEqual(['forced', 'shutdown']);
  });

  /**
   * The regression the dispose itself introduced, and the reason a spy-only fake could not see it.
   *
   * `dispose()` and `finish()` share one `finished` flag, so disposing DISABLES the child's exit
   * callback. `shutdown()` disposed and settled nothing, so the run stayed `running` forever and
   * `running.size` never dropped — `pump()` could never start another run. That is the wedge this
   * queue exists to prevent, reintroduced by the fix for a leak.
   *
   * The fake below carries the real interaction — a shared flag whose `dispose` suppresses the
   * later exit — because a `vi.fn()` that only records the call cannot express it.
   */
  it('settles a run it shuts down, even though disposing suppresses the exit callback', () => {
    const queue = build();
    runner.startRun = ({ worktree, onExit }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun & { dispose: () => void };
      let done = false;
      handle.kill = vi.fn();
      // The shape of the real handle: dispose and exit share one latch.
      handle.dispose = () => {
        done = true;
      };
      handle.finish = (code: number) => {
        if (done) return;
        done = true;
        onExit?.(code);
      };
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };

    const run = queue.request({ worktree: '/wt/a' });
    queue.shutdown();
    // The SIGKILLed child's exit arrives after the dispose and is swallowed — as it is in reality.
    runner.started[0].finish(-1);

    expect(queue.get(run.id).status).toBe('cancelled');
    expect(queue.get(run.id).error).toMatch(/daemon-shutdown/);
    // The slot, which is the thing that actually wedges: it must be free.
    expect(queue.running.size).toBe(0);
  });

  // A runner that predates `dispose` must not crash the sweep — the queue calls it optionally.
  it('tolerates a handle with no dispose', () => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const stuck = queue.request({ worktree: '/wt/a' });
    now += 60_001;
    queue.sweep();
    now += 5_000;
    expect(() => queue.sweep()).not.toThrow();
    expect(queue.get(stuck.id).status).toBe('timeout');
  });

  it('does not settle a forced run twice when its exit finally arrives', () => {
    const queue = build({ killGraceMs: 5_000 });
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    now += 60_001;
    queue.get(next.id);
    queue.sweep(); // kill requested; the fake's kill emits exit, settling it here
    expect(queue.get(stuck.id).status).toBe('timeout');
    expect(queue.get(next.id).status).toBe('running');

    now += 10_000;
    const swept = queue.sweep();

    expect(swept.forced).toEqual([]);
    expect(queue.get(next.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('ignores an exit from a handle the run no longer owns', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    runner.started[0].finish(0);
    expect(queue.get(second.id).status).toBe('running');

    // A late exit from the first run's dead handle must not settle anything or free a second slot.
    runner.started[0].finish(1);

    expect(queue.get(first.id).status).toBe('completed');
    expect(queue.get(first.id).exitCode).toBe(0);
    expect(queue.get(second.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('cancels a queued run without disturbing the running one', () => {
    const queue = build();
    const running = queue.request({ worktree: '/wt/a' });
    const doomed = queue.request({ worktree: '/wt/b' });
    const behind = queue.request({ worktree: '/wt/c' });

    queue.cancel(doomed.id);

    expect(queue.get(doomed.id).status).toBe('cancelled');
    expect(queue.get(behind.id).position).toBe(1);
    expect(queue.get(running.id).status).toBe('running');
    expect(runner.started).toHaveLength(1);
  });

  it('returns null for a run it has never heard of, so a waiter can fail instead of poll forever', () => {
    const queue = build();

    expect(queue.get('nope')).toBeNull();
    expect(queue.logs('nope')).toBeNull();
    expect(queue.cancel('nope')).toBeNull();
  });

  // Every sweep between the kill and the grace expiring must leave the deadline alone. Sweeping
  // resets it, the force-release never fires, and the queue wedges permanently -- and the daemon
  // sweeps every 5s plus on every request, against a 30s default grace.
  it('does not restart the kill grace on each sweep', () => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    now += 60_001;
    queue.get(next.id);
    expect(queue.sweep().timedOut).toEqual([stuck.id]);

    // Four sweeps inside the grace, the way the daemon's own 5s timer would.
    for (let i = 0; i < 4; i += 1) {
      now += 1_000;
      queue.get(next.id);
      expect(queue.sweep().forced).toEqual([]);
    }
    now += 1_001;

    expect(queue.sweep().forced).toEqual([stuck.id]);
    expect(queue.get(next.id).status).toBe('running');
  });

  it('refuses to call a killed run a pass, even when its process exited 0', () => {
    const queue = build();
    // A kill that does not itself end the process — on Windows it is a separately spawned
    // taskkill, so the child can still exit on its own terms first.
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = (code: number) => handle.emit('exit', code);
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const run = queue.request({ worktree: '/wt/a' });

    queue.cancel(run.id);
    // The child exited cleanly in the window between the kill being issued and it landing.
    runner.started[0].finish(0);

    const view = queue.get(run.id);
    expect(view.status).toBe('cancelled');
    expect(view.exitCode).toBe(0);
    // What a waiter would exit with. 0 here would report a green suite that never finished.
    expect(exitCodeFor(view)).toBe(1);
  });

  it('exits nonzero for every terminal state that is not a clean pass', () => {
    expect(exitCodeFor({ status: 'completed', exitCode: 0 })).toBe(0);
    expect(exitCodeFor({ status: 'timeout', exitCode: 0 })).toBe(1);
    expect(exitCodeFor({ status: 'cancelled', exitCode: 0 })).toBe(1);
    expect(exitCodeFor({ status: 'abandoned', exitCode: null })).toBe(1);
    expect(exitCodeFor({ status: 'error', exitCode: null })).toBe(1);
    // A distinctive code, so the table distinguishes passing the real code through from
    // returning a bare 1.
    expect(exitCodeFor({ status: 'failed', exitCode: 130 })).toBe(130);
    // A child killed by a signal reports no code; -1 must not reach a shell as 255.
    expect(exitCodeFor({ status: 'error', exitCode: -1 })).toBe(1);
  });

  it('calls a signal-killed run an error, not a test failure', () => {
    const queue = build();
    const run = queue.request({ worktree: '/wt/a' });

    runner.started[0].finish(-1); // node reports no code when a child dies by signal

    expect(queue.get(run.id).status).toBe('error');
    expect(exitCodeFor(queue.get(run.id))).toBe(1);
  });

  it('keeps the verdict of a runner that reported an exit and then threw', () => {
    const queue = build();
    runner.startRun = ({ worktree, onExit }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      onExit!(0);
      throw new Error('boom after reporting');
    };

    const run = queue.request({ worktree: '/wt/a' });

    expect(queue.get(run.id).status).toBe('completed');
    expect(queue.get(run.id).exitCode).toBe(0);
  });

  it('ignores a late exit arriving after the slot was force-released', () => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = (code: number) => handle.emit('exit', code);
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    now += 60_001;
    queue.get(next.id);
    queue.sweep();
    now += 5_001;
    expect(queue.sweep().forced).toEqual([stuck.id]);
    expect(queue.get(next.id).status).toBe('running');

    // The abandoned process finally exits, cleanly, long after its slot was given away.
    runner.started[0].finish(0);

    expect(queue.get(stuck.id).status).toBe('timeout');
    expect(queue.get(stuck.id).exitCode).toBeNull();
    expect(queue.get(next.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('settles a runner that reports its exit before it returns a handle', () => {
    const queue = build();
    runner.startRun = ({ worktree, onExit }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      onExit!(0); // synchronous, before this function has returned anything
      return handle;
    };

    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    // Without this, the finished run holds the only slot until the run ceiling expires and
    // everything behind it is abandoned instead of run.
    expect(queue.get(first.id).status).toBe('completed');
    expect(queue.get(second.id).status).toBe('completed');
    expect(runner.started).toHaveLength(2);
  });

  it('hands back a wait command naming the run', () => {
    const queue = build({ waitCommand: 'node cli.mjs test wait' });
    const run = queue.request({ worktree: '/wt/a' });

    expect(run.waitCommand).toBe(`node cli.mjs test wait ${run.id}`);
  });
});

/**
 * A run's log window is bounded, and it has to be. What is not acceptable is dropping lines
 * without saying so: a clipped log is byte-for-byte indistinguishable from a whole one, which is
 * how a fragment gets read — and quoted — as a complete run.
 *
 * Measured through the real queue before this counter existed: a child that wrote 5,000 lines
 * produced 1,998 in the window, and neither the run view nor the log response said a word.
 */
describe('a clipped log announces itself', () => {
  const drive = (lines: number) => {
    const { startRun } = makeRunner();
    const queue = new TestQueue({ startRun });
    const view = queue.request({ worktree: '/repo' });
    const run = queue.runs.get(view.id);
    for (let i = 0; i < lines; i++) queue.addLog(run, 'stdout', `line ${i}`);
    return queue.get(view.id);
  };

  it('reports nothing dropped while the window still holds everything', () => {
    const state = drive(10);
    expect(state.logIndex).toBe(10);
    expect(state.logsDropped).toBe(0);
  });

  // The count is the difference between what was emitted and what survives, so a reader can tell
  // exactly how much of the run is missing rather than only that some of it is.
  it('counts every line the window threw away', () => {
    const state = drive(5000);
    expect(state.logIndex).toBe(5000);
    expect(state.logsDropped).toBe(3000);
    expect(state.logIndex - state.logsDropped).toBe(2000);
  });

  // The waiters warn, but `test logs` fetches the window directly and would otherwise get a
  // fragment with nothing attached to it. The daemon's log route reads this.
  it('offers the same count to a caller reading logs directly', () => {
    const { startRun } = makeRunner();
    const queue = new TestQueue({ startRun });
    const { id } = queue.request({ worktree: '/repo' });
    const run = queue.runs.get(id);
    for (let i = 0; i < 2500; i++) queue.addLog(run, 'stdout', `line ${i}`);
    expect(queue.droppedFor(id)).toBe(500);
    expect(queue.logs(id, -1)).toHaveLength(2000);
    // An unknown run is 0 dropped, not a throw: the route answers 404 on its own terms.
    expect(queue.droppedFor('nope')).toBe(0);
  });
});
