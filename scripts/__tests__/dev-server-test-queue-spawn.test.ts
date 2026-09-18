import { EventEmitter } from 'events';
import type * as ChildProcess from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawn = vi.fn();

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcess>()),
  spawn: (...args: unknown[]) => spawn(...args),
}));

// Lives under scripts/ because the daemon is not part of the app's module graph — same arrangement
// as the rest of the queue's tests.
const { defaultStartRun, TestQueue } = await import(
  '../../.claude/skills/dev-server/scripts/test-queue.mjs'
);

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

  // Typed here rather than at each call: the runner is a .mjs module, so TS infers a bare
  // EventEmitter and does not see the `dispose` the handle actually carries.
  const start = (opts: Record<string, unknown>) => {
    const handle = defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
      ...opts,
    }) as EventEmitter & { dispose: () => void };
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

  it('honours the space-separated spelling of the caller flag too', () => {
    start({ args: ['--max-workers', '3'], maxWorkers: 15 });
    expect(argvOf(0)).toEqual(['run', 'test:unit:run', '--max-workers', '3']);
  });

  // The cap is configured on the QUEUE and has to survive the hop into the runner. Asserting on
  // defaultStartRun alone would pass with that hop deleted.
  it("hands the queue's cap to the runner it starts", () => {
    const startRun = vi.fn<(opts: { maxWorkers: number | null }) => EventEmitter>(
      () => new EventEmitter()
    );
    // Cast for the same reason as the handle above — TestQueue comes from a .mjs module, so TS
    // infers `request`'s payload from nothing and lands on `{ args?: never[] }`.
    const queue = new TestQueue({ concurrency: 1, maxWorkers: 15, startRun }) as unknown as {
      request: (run: { worktree: string; args: string[] }) => unknown;
    };

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
