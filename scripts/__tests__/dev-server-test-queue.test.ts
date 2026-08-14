import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ships with the dev-server skill (plain .mjs, loaded by the daemon under node, never bundled),
// so it is imported by path rather than moved into src/ — same arrangement as the port probe.
import { TestQueue } from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

type FakeRun = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  finish: (code: number) => void;
  worktree: string;
};

// Every fake terminates on demand and nothing here drives a loop: the queue owns no timers, so
// each deadline is reached by moving the injected clock. A regression fails on an assertion
// naming the wrong position or status, never by hanging the runner.
function makeRunner() {
  const started: FakeRun[] = [];
  const startRun = ({ worktree }: { worktree: string }) => {
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
      startRun: (opts: { worktree: string }) => runner.startRun(opts),
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
    const queue = build();
    const run = queue.request({ worktree: '/wt/a' });

    now += 30_000; // three times the abandon window, half the run ceiling
    const swept = queue.sweep();

    expect(swept.abandoned).toEqual([]);
    expect(queue.get(run.id).status).toBe('running');
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
    runner.startRun = ({ worktree }: { worktree: string }) => {
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

  it('hands back a wait command naming the run', () => {
    const queue = build({ waitCommand: 'node cli.mjs test wait' });
    const run = queue.request({ worktree: '/wt/a' });

    expect(run.waitCommand).toBe(`node cli.mjs test wait ${run.id}`);
  });
});
