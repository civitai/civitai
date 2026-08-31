import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `banConfirmed` is what stops Bulk Ban queuing a thousand overlapping fan-outs on the primary. It used
 * to poll `bannedAt`, which `toggleBan` writes BEFORE the model unpublish, media block, comment
 * flagging, index removal and subscription cancels — so it answered "landed" while all of that was
 * still running, and the checkpoint paced the loop without bounding anything.
 *
 * It now polls `banDetails.completedAt`, stamped as the last statement of the ban branch. Both halves
 * of that are invisible from the outside: the emitted SQL is the only place the column choice shows up,
 * and returning true too early looks exactly like working correctly until a sweep flattens the primary.
 */

// TWO capture arrays, deliberately. A single client shared by both exports would record the statement
// whichever tier it ran on, so the assertion about reading the primary would hold no matter what the
// code did.
const captured = vi.hoisted(() => [] as string[]);
const capturedRead = vi.hoisted(() => [] as string[]);

vi.mock('$lib/server/db', async () => {
  const { capturingDb } = await import('../../../test/capture-sql');
  return { dbRead: capturingDb(capturedRead), dbWrite: capturingDb(captured) };
});

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: () => ({ locals: {} }) }));

const { banConfirmed } = await import('../user-actions.service');

describe('banConfirmed', () => {
  beforeEach(() => {
    captured.length = 0;
    capturedRead.length = 0;
    vi.useFakeTimers();
  });

  const run = async (attempts: number) => {
    const promise = banConfirmed(1, attempts);
    await vi.runAllTimersAsync();
    return promise;
  };

  it('polls the completion stamp, not the flag written before the fan-out', async () => {
    await run(1);

    // The revert. `bannedAt` is set first, so confirming on it is confirming nothing about the work.
    expect(captured[0]).toContain(`meta #>> '{banDetails,completedAt}'`);
    expect(captured[0]).not.toContain('"bannedAt"');
  });

  it('reads the primary, never the replica', async () => {
    // The write it is waiting on is in flight; a replica can answer from before it, and the caller
    // would be told a ban that landed had failed.
    await run(1);

    expect(captured).toHaveLength(1);
    expect(capturedRead).toHaveLength(0);
  });

  it('gives the fan-out a real budget rather than the old three seconds', async () => {
    // The stamp lands after the expensive half, so the poll has to outlast it — the previous 6
    // attempts were sized for a write that happens first.
    await run(20);

    expect(captured).toHaveLength(20);
  });
});
