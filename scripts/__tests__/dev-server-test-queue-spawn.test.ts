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
const { defaultStartRun } = await import('../../.claude/skills/dev-server/scripts/test-queue.mjs');

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
    defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
    });

    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CIVITAI_TEST_QUEUE).toBe('0');
  });

  // The flag is switched off rather than the environment replaced: the child still needs PATH and
  // everything else the daemon was started with.
  it('passes the rest of the environment through', () => {
    process.env.CIVITAI_TEST_QUEUE_PROBE = 'kept';

    defaultStartRun({
      worktree: '/repo',
      args: [],
      onLog: () => undefined,
      onExit: () => undefined,
    });

    const env = (spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
    expect(env.CIVITAI_TEST_QUEUE_PROBE).toBe('kept');

    delete process.env.CIVITAI_TEST_QUEUE_PROBE;
  });
});
