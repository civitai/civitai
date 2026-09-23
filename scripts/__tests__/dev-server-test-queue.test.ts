import { EventEmitter } from 'events';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Ships with the dev-server skill (plain .mjs, loaded by the daemon under node, never bundled),
// so it is imported by path rather than moved into src/ — same arrangement as the port probe.
import type { RunHandle } from '../../.claude/skills/dev-server/scripts/test-queue.mjs';
import { TestQueue, exitCodeFor } from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

type Kill = RunHandle['kill'];

type FakeRun = EventEmitter & {
  kill: Mock<Kill>;
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
    handle.kill = vi.fn<Kill>(() => {
      handle.emit('exit', 1);
    });
    handle.finish = (code: number) => handle.emit('exit', code);
    handle.worktree = worktree;
    started.push(handle);
    return handle;
  };
  return { started, startRun };
}

// Through `get`, not `view`: reading a run is also the touch that keeps it from being swept, and
// several tests depend on that side effect.
function mustGet(queue: TestQueue, id: string) {
  const view = queue.get(id);
  if (!view) throw new Error(`the queue has no run ${id}`);
  return view;
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

    expect(mustGet(queue, first.id).status).toBe('completed');
    expect(mustGet(queue, first.id).exitCode).toBe(0);
    expect(mustGet(queue, second.id).status).toBe('running');
    expect(mustGet(queue, second.id).position).toBe(0);
    expect(runner.started).toHaveLength(2);
  });

  it('reports a nonzero exit as failed and still frees the slot', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    runner.started[0].finish(1);

    expect(mustGet(queue, first.id).status).toBe('failed');
    expect(mustGet(queue, first.id).exitCode).toBe(1);
    expect(mustGet(queue, second.id).status).toBe('running');
  });

  it('honours a configured concurrency above one', () => {
    // The group limit is raised WITH the lane limit because they are different constraints: this
    // test is about the lane one. The case where they disagree is pinned on its own below.
    const queue = build({ concurrency: 2, groupConcurrency: { saturating: 2 } });

    queue.request({ worktree: '/wt/a' });
    queue.request({ worktree: '/wt/b' });
    const third = queue.request({ worktree: '/wt/c' });

    expect(runner.started).toHaveLength(2);
    expect(third.status).toBe('queued');
    expect(third.position).toBe(1);
  });

  /**
   * 🔴 The group budget is a CEILING over the lane limits, not a suggestion. Raising a saturating
   * lane past its group's limit does not admit a second run - `unit`, `packages`, `apps` and
   * `component` each want most of the machine, so only one of them runs at a time whichever lane
   * it came from.
   *
   * If you are here because `test config 2` no longer starts two suites: that is this rule, and
   * the fix is `test config 2 --saturating 2`, not deleting the condition. Six lanes at 1 each
   * admitting together was ~62 vitest workers on 32 cores, two 8 GB tsc heaps and a browser suite,
   * which is what this exists to stop. Decision taken 2026-09-22.
   */
  it('does not admit a second saturating run just because the lane limit allows one', () => {
    const queue = build({ concurrency: 2, groupConcurrency: { saturating: 1 } });

    queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    expect(runner.started).toHaveLength(1);
    expect(second.status).toBe('queued');
  });

  it('admits a light run beside a saturating one, which is what the groups are for', () => {
    const queue = build({ concurrency: 1, groupConcurrency: { saturating: 1, light: 2 } });

    queue.request({ worktree: '/wt/a' });
    const check = queue.request({ worktree: '/wt/tc', kind: 'typecheck' });

    expect(check.status).toBe('running');
  });

  /**
   * 🔴 Arrival order WITHIN a group, not lane-declaration order. `pump` used to walk the lanes and
   * take each one's own head, which made the first-declared lane in a group a permanent priority:
   * with `saturating` at 1 and this box running the unit suite constantly, a queued `component`
   * run was measured still waiting after six later-arriving unit runs had started and finished.
   *
   * Overtaking ACROSS groups stays deliberate and is pinned separately below.
   */
  it('gives a freed saturating slot to the run that asked first, not to the first lane declared', () => {
    const queue = build({ groupConcurrency: { saturating: 1 } });

    const first = queue.request({ worktree: '/wt/a' });
    const component = queue.request({ worktree: '/wt/b', kind: 'component' });
    const laterUnit = queue.request({ worktree: '/wt/c' });

    expect([component.status, laterUnit.status]).toEqual(['queued', 'queued']);

    runner.started[0].finish(0);

    expect(mustGet(queue, component.id).status).toBe('running');
    expect(mustGet(queue, laterUnit.id).status).toBe('queued');
  });

  /**
   * 🔴 A lane its GROUP has stopped is paused, whatever its own limit says. Reporting only the
   * lane meant `--saturating 0` wedged five lanes while every surface said `paused: false` — the
   * waiter printed a position and polled forever, and polling touches the run, so the abandon
   * sweep never reclaimed it either.
   */
  it('reports a lane as paused when its group is what stopped it', () => {
    const queue = build({ concurrency: 1, groupConcurrency: { saturating: 0 } });
    const run = queue.request({ worktree: '/wt/a' });

    expect(run.status).toBe('queued');
    expect(run.paused).toBe(true);
    expect(run.effectiveLimit).toBe(0);
  });

  /**
   * 🔴 The light lane overtakes a run that is ALREADY QUEUED, not merely one that never arrived.
   * Nothing pinned this: the other overtake test requests its typecheck against an empty queue, so
   * a `pump` that only ever considers `this.order[0]` passed every test in this file while
   * destroying the property the lanes exist for — an edit/verify loop waiting behind someone
   * else's 500-second suite.
   */
  it('starts a light run that arrived AFTER a saturating run was already queued', () => {
    const queue = build({ groupConcurrency: { saturating: 1, light: 2 } });

    queue.request({ worktree: '/wt/a' });
    const blocked = queue.request({ worktree: '/wt/b' });
    const check = queue.request({ worktree: '/wt/tc', kind: 'typecheck' });

    expect(blocked.status).toBe('queued');
    expect(check.status).toBe('running');
  });

  /**
   * 🔴 Busy is not paused. A `pausedFor` that also counted a FULL group would make the waiter
   * announce "nothing will start until it is raised" on every ordinary wait, which is the kind of
   * false alarm people learn to ignore — and then miss the real one.
   */
  it('does not call a run paused just because its group is occupied', () => {
    const queue = build({ groupConcurrency: { saturating: 1 } });
    queue.request({ worktree: '/wt/a' });
    const waiting = queue.request({ worktree: '/wt/b', kind: 'component' });

    expect(waiting.status).toBe('queued');
    expect(waiting.paused).toBe(false);
    expect(waiting.pausedBy).toBeNull();
    expect(waiting.groupRunning).toBe(1);
  });

  /**
   * 🔴 A pause message must name the knob that actually unpauses it. `test config 1` raises the
   * unit LANE; printing that while the GROUP sits at 0 leaves the run wedged and reprints the same
   * advice. These assert the command, not merely that some command was produced.
   */
  it('names the group when the group is what stopped it', () => {
    const queue = build({ groupConcurrency: { saturating: 0 } });
    const run = queue.request({ worktree: '/wt/a' });
    expect(run.pausedBy).toBe('group');
    expect(run.resumeCommand).toBe('test config --saturating 1');
  });

  it('names the lane, with its own flag, when the lane is what stopped it', () => {
    const queue = build({ concurrency: { component: 0 } });
    const run = queue.request({ worktree: '/wt/a', kind: 'component' });
    expect(run.pausedBy).toBe('lane');
    expect(run.resumeCommand).toBe('test config --component 1');
  });

  /**
   * 🔴 The saturating group holds the lanes that each want most of the machine. If you are here
   * because you moved one of these into `light`: that is the 31-vitest-workers-plus-12-Chromium
   * pair CLAUDE.md names, and arbitrating it is what this queue exists for.
   */
  it.each(['component', 'packages', 'apps', 'geometry'])(
    'does not start a %s run beside a running unit suite',
    (kind) => {
      const queue = build({ groupConcurrency: { saturating: 1 } });
      queue.request({ worktree: '/wt/a' });
      expect(queue.request({ worktree: '/wt/b', kind }).status).toBe('queued');
    }
  );

  it('treats concurrency 0 as paused, and says so rather than leaving the caller guessing', () => {
    const queue = build({ concurrency: 0 });

    const run = queue.request({ worktree: '/wt/a' });

    expect(run.status).toBe('queued');
    expect(run.paused).toBe(true);
    expect(run.position).toBe(1);
    expect(runner.started).toHaveLength(0);

    queue.setConcurrency(1);

    expect(mustGet(queue, run.id).status).toBe('running');
    expect(mustGet(queue, run.id).paused).toBe(false);
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
    expect(mustGet(queue, abandoned.id).status).toBe('abandoned');
    expect(mustGet(queue, behind.id).status).toBe('queued');
    expect(mustGet(queue, behind.id).position).toBe(1);
    expect(mustGet(queue, first.id).status).toBe('running');
  });

  it('never abandons a run that is already executing — the daemon owns it, not the caller', () => {
    // Two running and one queued is the shape this test needs; the group limit is raised only to
    // reach it, and has nothing to do with what is being asserted.
    const queue = build({ concurrency: 2, groupConcurrency: { saturating: 2 } });
    const executing = queue.request({ worktree: '/wt/a' });
    queue.request({ worktree: '/wt/b' });
    const waiting = queue.request({ worktree: '/wt/c' });

    now += 30_000; // three times the abandon window, half the run ceiling
    const swept = queue.sweep();

    // The queued sibling proves the sweep ran and was capable of abandoning something; without it
    // an empty `abandoned` list would be true no matter what the sweep did.
    expect(swept.abandoned).toEqual([waiting.id]);
    expect(mustGet(queue, executing.id).status).toBe('running');
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
    expect(mustGet(queue, stuck.id).status).toBe('timeout');
    expect(mustGet(queue, next.id).status).toBe('running');
  });

  it('frees the slot when a killed process never exits, rather than holding it forever', () => {
    const queue = build({ killGraceMs: 5_000 });
    // A process that swallows the kill — the wedge this whole queue exists to prevent.
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
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
    expect(mustGet(queue, stuck.id).status).toBe('running'); // kill issued, exit not seen yet
    expect(mustGet(queue, next.id).status).toBe('queued');

    now += 5_000;
    const swept = queue.sweep();

    expect(swept.forced).toEqual([stuck.id]);
    expect(mustGet(queue, stuck.id).status).toBe('timeout');
    expect(mustGet(queue, stuck.id).error).toMatch(/did not exit after kill/);
    expect(mustGet(queue, next.id).status).toBe('running');
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
      handle.kill = vi.fn<Kill>();
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
      handle.kill = vi.fn<Kill>();
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

    expect(mustGet(queue, run.id).status).toBe('cancelled');
    expect(mustGet(queue, run.id).error).toMatch(/daemon-shutdown/);
    // The slot, which is the thing that actually wedges: it must be free.
    expect(queue.running.size).toBe(0);
  });

  /**
   * Releasing the SLOT matters more than releasing the file descriptors.
   *
   * `dispose()` does real IO and calls back into `onLog`, and it sits above the detach/release/
   * settle that free the slot. Unguarded, a throw there skips all three and the queue is wedged —
   * the identical failure the settle was added to fix. It also aborts the loop, leaving every
   * remaining run unkilled.
   */
  it.each([
    ['shutdown', (q: ReturnType<typeof build>) => q.shutdown(), 'cancelled'],
    [
      'the sweep force-release',
      (q: ReturnType<typeof build>) => {
        now += 60_001;
        q.sweep();
        now += 5_000;
        q.sweep();
      },
      'timeout',
    ],
  ])('frees the slot on %s even when dispose throws', (_name, act, expected) => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun & { dispose: () => void };
      handle.kill = vi.fn<Kill>();
      handle.finish = () => {};
      handle.dispose = () => {
        throw new Error('capture release blew up');
      };
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };

    const run = queue.request({ worktree: '/wt/a' });
    expect(() => act(queue)).not.toThrow();

    expect(queue.running.size).toBe(0);
    // The exact status for THIS path, not either-of. `toContain` over both would pass with the
    // wrong terminal status — a shutdown reported as a timeout, or the reverse — which is the
    // shape of assertion that lets a real mix-up through.
    expect(mustGet(queue, run.id).status).toBe(expected);
    // And it must SAY so. Swallowing this silently hides a clipped log behind `logsDropped: 0`,
    // which is the one outcome the queue's log contract rules out — and nothing asserted the line
    // existed, so both call sites could revert to a silent catch with the suite still green.
    const logs = queue.logs(run.id);
    if (!logs) throw new Error(`the queue has no run ${run.id}`);
    expect(logs.map((l: { message: string }) => l.message)).toContainEqual(
      expect.stringContaining('capture release failed: capture release blew up')
    );
  });

  // A runner that predates `dispose` must not crash the sweep — the queue calls it optionally.
  it('tolerates a handle with no dispose', () => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
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
    expect(mustGet(queue, stuck.id).status).toBe('timeout');
  });

  it('does not settle a forced run twice when its exit finally arrives', () => {
    const queue = build({ killGraceMs: 5_000 });
    const stuck = queue.request({ worktree: '/wt/a' });
    const next = queue.request({ worktree: '/wt/b' });

    now += 60_001;
    queue.get(next.id);
    queue.sweep(); // kill requested; the fake's kill emits exit, settling it here
    expect(mustGet(queue, stuck.id).status).toBe('timeout');
    expect(mustGet(queue, next.id).status).toBe('running');

    now += 10_000;
    const swept = queue.sweep();

    expect(swept.forced).toEqual([]);
    expect(mustGet(queue, next.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('ignores an exit from a handle the run no longer owns', () => {
    const queue = build();
    const first = queue.request({ worktree: '/wt/a' });
    const second = queue.request({ worktree: '/wt/b' });

    runner.started[0].finish(0);
    expect(mustGet(queue, second.id).status).toBe('running');

    // A late exit from the first run's dead handle must not settle anything or free a second slot.
    runner.started[0].finish(1);

    expect(mustGet(queue, first.id).status).toBe('completed');
    expect(mustGet(queue, first.id).exitCode).toBe(0);
    expect(mustGet(queue, second.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('cancels a queued run without disturbing the running one', () => {
    const queue = build();
    const running = queue.request({ worktree: '/wt/a' });
    const doomed = queue.request({ worktree: '/wt/b' });
    const behind = queue.request({ worktree: '/wt/c' });

    queue.cancel(doomed.id);

    expect(mustGet(queue, doomed.id).status).toBe('cancelled');
    expect(mustGet(queue, behind.id).position).toBe(1);
    expect(mustGet(queue, running.id).status).toBe('running');
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
      handle.kill = vi.fn<Kill>();
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
    expect(mustGet(queue, next.id).status).toBe('running');
  });

  it('refuses to call a killed run a pass, even when its process exited 0', () => {
    const queue = build();
    // A kill that does not itself end the process — on Windows it is a separately spawned
    // taskkill, so the child can still exit on its own terms first.
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
      handle.finish = (code: number) => handle.emit('exit', code);
      handle.worktree = worktree;
      runner.started.push(handle);
      return handle;
    };
    const run = queue.request({ worktree: '/wt/a' });

    queue.cancel(run.id);
    // The child exited cleanly in the window between the kill being issued and it landing.
    runner.started[0].finish(0);

    const view = mustGet(queue, run.id);
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

    expect(mustGet(queue, run.id).status).toBe('error');
    expect(exitCodeFor(mustGet(queue, run.id))).toBe(1);
  });

  it('keeps the verdict of a runner that reported an exit and then threw', () => {
    const queue = build();
    runner.startRun = ({ worktree, onExit }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
      handle.finish = () => {};
      handle.worktree = worktree;
      runner.started.push(handle);
      onExit!(0);
      throw new Error('boom after reporting');
    };

    const run = queue.request({ worktree: '/wt/a' });

    expect(mustGet(queue, run.id).status).toBe('completed');
    expect(mustGet(queue, run.id).exitCode).toBe(0);
  });

  it('ignores a late exit arriving after the slot was force-released', () => {
    const queue = build({ killGraceMs: 5_000 });
    runner.startRun = ({ worktree }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
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
    expect(mustGet(queue, next.id).status).toBe('running');

    // The abandoned process finally exits, cleanly, long after its slot was given away.
    runner.started[0].finish(0);

    expect(mustGet(queue, stuck.id).status).toBe('timeout');
    expect(mustGet(queue, stuck.id).exitCode).toBeNull();
    expect(mustGet(queue, next.id).status).toBe('running');
    expect(runner.started).toHaveLength(2);
  });

  it('settles a runner that reports its exit before it returns a handle', () => {
    const queue = build();
    runner.startRun = ({ worktree, onExit }: RunnerArgs): FakeRun => {
      const handle = new EventEmitter() as FakeRun;
      handle.kill = vi.fn<Kill>();
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
    expect(mustGet(queue, first.id).status).toBe('completed');
    expect(mustGet(queue, second.id).status).toBe('completed');
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
    return mustGet(queue, view.id);
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
