import { EventEmitter } from 'events';
import type * as ChildProcess from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RunHandle } from '../../.claude/skills/dev-server/scripts/test-queue.mjs';

const spawn = vi.fn();

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => spawn(...args),
}));

// Lives under scripts/ because the daemon is not part of the app's module graph — same arrangement
// as the rest of the queue's tests.
const { defaultStartRun, TestQueue, cacheReporterArgv, cacheReporterPath, RUN_KINDS } =
  await import('../../.claude/skills/dev-server/scripts/test-queue.mjs');

const fakeChild = () => {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 1234;
  child.kill = vi.fn();
  return child;
};

beforeEach(() => {
  vi.clearAllMocks();
  spawn.mockReturnValue(fakeChild());
});

describe('the queued run does not re-enter the queue', () => {
  /**
   * The command the daemon runs is the script that routes to this queue. If the child inherits
   * `CIVITAI_TEST_QUEUE`, it enqueues a second run and waits for it while this run holds the slot
   * that one needs — every full-suite run deadlocks, and raising concurrency only changes how many
   * agents it takes, because each logical run then occupies two slots.
   */
  it('disables the queue flag for the process it spawns', () => {
    // Disposed, because a run now owns a capture file, two descriptors and a tail interval, and
    // the fake child below never emits 'exit'. Without this, every `pnpm test:unit` left two
    // files in /tmp forever — measured at 15 stale files before it was noticed.
    const handle = defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
    });
    handle.dispose();

    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CIVITAI_TEST_QUEUE).toBe('0');
  });

  // The flag is switched off rather than the environment replaced: the child still needs PATH and
  // everything else the daemon was started with.
  it('passes the rest of the environment through', () => {
    process.env.CIVITAI_TEST_QUEUE_PROBE = 'kept';

    const handle = defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
    });
    handle.dispose();

    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CIVITAI_TEST_QUEUE_PROBE).toBe('kept');

    delete process.env.CIVITAI_TEST_QUEUE_PROBE;
  });
});

/**
 * The queue suites all use fake runners, so nothing else reads the handle `defaultStartRun` builds.
 * A member dropped from it - `kill` is the one that matters, since cancel, timeout and shutdown call
 * it unguarded - otherwise passes every test in the repo.
 */
describe('the handle a real run hands back', () => {
  const platform = process.platform;
  const setPlatform = (value: NodeJS.Platform) =>
    Object.defineProperty(process, 'platform', { value, configurable: true });

  afterEach(() => {
    setPlatform(platform);
    vi.restoreAllMocks();
  });

  const startOn = (value: NodeJS.Platform) => {
    setPlatform(value);
    return defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
    });
  };

  it('carries the child pid', () => {
    const handle = startOn('linux');
    handle.dispose();
    expect(handle.pid).toBe(1234);
  });

  it('kills the whole process group off Windows', () => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const handle = startOn('linux');
    handle.dispose();
    handle.kill();
    expect(kill).toHaveBeenCalledWith(-1234, 'SIGKILL');
  });

  it('kills the process tree with taskkill on Windows', () => {
    const handle = startOn('win32');
    handle.dispose();
    handle.kill();
    expect(spawn).toHaveBeenLastCalledWith(
      'taskkill',
      ['/pid', '1234', '/f', '/t'],
      expect.objectContaining({ shell: true })
    );
  });
});

/**
 * The worker cap only exists because concurrency > 1 is on the table: vitest sizes its own pool at
 * `cpus - 1`, so two uncapped runs ask for 62 workers on a 32-core box. `VITEST_MAX_WORKERS` cannot
 * carry it — the daemon spawns the child with the daemon's own environment — so the CLI flag is the
 * only channel, and these pin that it is actually on the command line.
 *
 * 🔴 If you are here to delete one of these: the failure they protect against is SILENT. A cap that
 * never reaches vitest leaves the summary, the exit code and the test count all identical; the only
 * visible difference is the box falling over under an oversubscribed pair. Do not replace these with
 * an assertion on `queue.maxWorkers`, which passes with the argv line deleted.
 */
describe("the queue caps each run's vitest pool", () => {
  const argvOf = (call: number) => spawn.mock.calls[call][1] as string[];

  const start = (opts: Record<string, unknown>) => {
    const handle = defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
      ...opts,
    });
    handle.dispose();
  };

  it('puts --max-workers on the command line when a cap is set', () => {
    start({ maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run', '--max-workers=15']);
  });

  // The default is no cap, and that has to stay byte-identical to what the daemon ran before this
  // setting existed — otherwise every run on a machine that never configured it changes width.
  it('adds nothing when no cap is set', () => {
    start({});
    expect(argvOf(0)).toEqual(['run', 'test:unit:run']);
  });

  // A caller who named a width asked for that width. Appending a second copy would decide the run
  // by argument order, which is not a thing either of them chose.
  it('leaves a caller-supplied width alone', () => {
    start({ args: ['--max-workers=3'], maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run', '--max-workers=3']);
  });

  // vitest reads kebab and camel as one flag, so a caller's `--maxWorkers` is the same request as
  // `--max-workers` and must suppress the queue's copy just the same.
  it('honours the camelCase spelling of the caller flag too', () => {
    start({ args: ['--maxWorkers=3'], maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run', '--maxWorkers=3']);
  });

  // tsc has no worker pool, so the flag would reach it as an unknown argument rather than a smaller
  // run. Pinned because the cap is configured on the QUEUE, which now serves both lanes.
  it('runs the typecheck script and never hands it the worker cap', () => {
    start({ kind: 'typecheck', maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'typecheck']);
  });

  it('honours the space-separated spelling of the caller flag too', () => {
    start({ args: ['--max-workers', '3'], maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run', '--max-workers', '3']);
  });

  // The cap is configured on the QUEUE and has to survive the hop into the runner. Asserting on
  // defaultStartRun alone would pass with that hop deleted.
  it("hands the queue's cap to the runner it starts", () => {
    const startRun = vi.fn<(opts: { maxWorkers: number | null }) => RunHandle>(() =>
      Object.assign(new EventEmitter(), { kill: vi.fn<RunHandle['kill']>() })
    );
    const queue = new TestQueue({ concurrency: 1, maxWorkers: 15, startRun });

    queue.request({ worktree: '/repo', args: [] });

    expect(startRun).toHaveBeenCalledTimes(1);
    expect(startRun.mock.calls[0][0]).toMatchObject({ maxWorkers: 15 });
  });

  // 0 is not a smaller run, it is no run — and vitest reads a falsy width as "unset", so a 0 that
  // slipped through would silently restore the uncapped pool this setting exists to prevent.
  it('refuses a width of zero rather than treating it as a pause', () => {
    expect(() => new TestQueue({ concurrency: 1, maxWorkers: 0 })).toThrow(/integer >= 1/);
  });
});

/**
 * The cache rides on the fleet's real queued runs, so the one thing its wiring must not do is change
 * them. Naming any `--reporter` replaces vitest's default — so a caller who named none has to get
 * `default` back, or turning the cache on silently strips every queued run's normal output.
 */
describe('result cache on queued runs', () => {
  const argvOf = (call: number) => spawn.mock.calls[call][1] as string[];
  const envOf = (call: number) =>
    (spawn.mock.calls[call][2] as { env: Record<string, string> }).env;
  // The repo's own tree, so the reporter file really exists and the argv is not vacuously empty.
  const worktree = process.cwd();
  const reporter = cacheReporterPath(worktree);
  const start = (opts: Record<string, unknown>) => {
    const handle = defaultStartRun({
      worktree,
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
      ...opts,
    });
    handle.dispose();
  };

  it('adds nothing and tells the run the cache is off while it is off', () => {
    start({ cacheMode: 'off' });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run']);
    expect(envOf(0).CIVITAI_TEST_CACHE).toBe('off');
  });

  it('keeps the default reporter beside the cache one when the caller named none', () => {
    start({ cacheMode: 'on' });
    expect(argvOf(0)).toEqual([
      'run',
      'test:unit:run',
      '--reporter=default',
      `--reporter=${reporter}`,
    ]);
    expect(envOf(0).CIVITAI_TEST_CACHE).toBe('on');
  });

  it('adds only the cache reporter when the caller chose their own', () => {
    start({ cacheMode: 'shadow', args: ['--reporter=json'] });
    expect(argvOf(0)).toEqual([
      'run',
      'test:unit:run',
      '--reporter=json',
      `--reporter=${reporter}`,
    ]);
  });

  // tsc would reject a vitest reporter, and the cache has nothing to skip in a typecheck.
  it('leaves a typecheck untouched', () => {
    start({ cacheMode: 'on', kind: 'typecheck' });
    expect(argvOf(0)).toEqual(['run', 'typecheck']);
    expect(envOf(0).CIVITAI_TEST_CACHE).toBe('off');
  });

  /**
   * 🔴 The case the `capWorkers` / `resultCache` split exists for, and the only lane where the two
   * disagree. A browser suite IS vitest, so `--max-workers` means something to it - but the cache
   * sequencer only ever skips files in the `unit` projects, so the reporter would attach to a run
   * it can skip nothing in and write ledger entries for it anyway. While one flag answered both
   * questions this lane could not have had the cap without the cache. If you are here because you
   * merged them back: this assertion is the reason not to.
   */
  it('caps a component run without caching it', () => {
    start({ cacheMode: 'on', kind: 'component', maxWorkers: 4 });
    expect(argvOf(0)).toEqual(['run', 'test:component', '--max-workers=4']);
    expect(envOf(0).CIVITAI_TEST_CACHE).toBe('off');
  });

  /**
   * 🔴 A width ABOVE the ceiling, which is the only place a ceiling is observable. The case above
   * asks for 4 and would pass identically with the ceiling deleted - measured, not assumed.
   *
   * The ceiling exists because `getThreadsCount` returns a caller's `--max-workers` UNCLAMPED for
   * the browser pool, so the queue's own cap, set for vitest workers, would launch that many
   * CHROMIUM instances instead. The daemon runs at 15 today; 12 is what upstream calls safe.
   */
  it('never hands the browser pool more instances than its ceiling', () => {
    start({ kind: 'component', maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:component', '--max-workers=12']);
  });

  it('leaves a width under the ceiling alone rather than raising it', () => {
    start({ kind: 'component', maxWorkers: 3 });
    expect(argvOf(0)).toEqual(['run', 'test:component', '--max-workers=3']);
  });

  /**
   * 🔴 A ceiling CLAMPS a width the caller asked for; it never invents one. When the daemon is
   * uncapped — which is the default — the browser lanes must pass nothing and let vitest choose
   * `min(12, cpus - 1)` for itself. Originating from the ceiling put `--max-workers=12` on every
   * uncapped run, which on a box with 12 cores or fewer is MORE Chromium instances than before.
   */
  it.each(['component', 'geometry'] as const)('adds no width to an uncapped %s run', (kind) => {
    start({ kind, maxWorkers: null });
    expect(argvOf(0)).toEqual(['run', RUN_KINDS[kind].script]);
  });

  /**
   * 🔴 Only the `unit` projects can be skipped by the cache sequencer, so every other vitest lane
   * must be told the cache is off. A lane marked cacheable attaches the reporter to a run it can
   * skip nothing in and writes ledger entries for it.
   */
  it.each(['packages', 'apps', 'geometry'])('never caches a %s run', (kind) => {
    start({ cacheMode: 'on', kind });
    expect(envOf(0).CIVITAI_TEST_CACHE).toBe('off');
    expect(argvOf(0).some((a) => String(a).startsWith('--reporter'))).toBe(false);
  });

  // A tree without the cache files runs uncached rather than as a vitest that cannot load its
  // reporter and fails every queued suite.
  it('adds nothing when the reporter file is absent', () => {
    expect(cacheReporterArgv('on', [], '/nowhere/reporter.mjs')).toEqual([]);
  });

  it("hands the queue's cache mode to the runner it starts", () => {
    const startRun = vi.fn<(opts: { cacheMode: string }) => RunHandle>(() =>
      Object.assign(new EventEmitter(), { kill: vi.fn<RunHandle['kill']>() })
    );
    const queue = new TestQueue({ concurrency: 1, cacheMode: 'on', startRun });
    queue.request({ worktree: '/repo', args: [] });
    expect(startRun.mock.calls[0][0]).toMatchObject({ cacheMode: 'on' });
  });

  it('refuses an unknown cache mode', () => {
    expect(() => new TestQueue({ concurrency: 1, cacheMode: 'yes' })).toThrow(/cacheMode must be/);
  });
});
