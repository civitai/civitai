import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the in-review snapshot retention sweep.
 *
 * The two properties that MUST hold, because getting either wrong destroys work
 * a moderator or developer is relying on:
 *  1. THE PENDING GATE — snapshots are keyed per-slug and overwritten on every
 *     submit, so a purge triggered by an old rejected request must NOT delete a
 *     snapshot a different, still-pending request for the same slug owns.
 *  2. THE 30-DAY BOUNDARY — a request that went terminal less than
 *     REVIEW_SNAPSHOT_PURGE_AFTER_MS ago is retained, not reclaimed.
 */

const { mockFindMany, mockFindFirst, mockDelete, mockLogToAxiom, mockGetJobDate, mockSetCursor } =
  vi.hoisted(() => ({
    mockFindMany: vi.fn(),
    mockFindFirst: vi.fn(),
    mockDelete: vi.fn(),
    mockLogToAxiom: vi.fn(() => Promise.resolve(undefined)),
    mockGetJobDate: vi.fn(),
    mockSetCursor: vi.fn(() => Promise.resolve(undefined)),
  }));

vi.mock('~/server/db/client', () => ({
  dbRead: { appBlockPublishRequest: { findMany: (...a: unknown[]) => mockFindMany(...a) } },
  dbWrite: { appBlockPublishRequest: { findFirst: (...a: unknown[]) => mockFindFirst(...a) } },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  deleteReviewRepo: (...a: unknown[]) => mockDelete(...a),
}));
vi.mock('~/server/logging/client', () => ({
  logToAxiom: (...a: unknown[]) => mockLogToAxiom(...a),
}));
// createJob wraps the handler in lock/metric machinery we don't need here — stub
// it to hand back the bare handler (mirrors the sibling block-job tests).
vi.mock('../job', () => ({
  createJob: (_name: string, _cron: string, fn: () => unknown) => fn,
  getJobDate: (...a: unknown[]) => mockGetJobDate(...a),
}));

import {
  purgeExpiredReviewSnapshots,
  purgeReviewSnapshotsJob,
  REVIEW_SNAPSHOT_PURGE_AFTER_MS,
  REVIEW_SNAPSHOT_PURGE_BATCH_SIZE,
} from '../purge-review-snapshots';

const NOW = new Date('2026-07-31T00:00:00.000Z');
/** Terminal exactly this long ago = comfortably past the retention window. */
const longAgo = (extraMs = 24 * 60 * 60 * 1000) =>
  new Date(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS - extraMs);

type Row = { id: string; slug: string; status: string; updatedAt: Date };
const row = (slug: string, updatedAt = longAgo(), status = 'rejected'): Row => ({
  id: `pubreq_${slug}`,
  slug,
  status,
  updatedAt,
});

beforeEach(() => {
  mockFindMany.mockReset();
  mockFindFirst.mockReset();
  mockDelete.mockReset();
  mockLogToAxiom.mockReset();
  mockLogToAxiom.mockReturnValue(Promise.resolve(undefined));
  mockSetCursor.mockReset();
  mockSetCursor.mockReturnValue(Promise.resolve(undefined));
  mockGetJobDate.mockReset();
  mockGetJobDate.mockResolvedValue([new Date(0), mockSetCursor]);
  // Default: nothing pending, delete succeeds.
  mockFindFirst.mockResolvedValue(null);
  mockDelete.mockResolvedValue('deleted');
});

describe('purgeExpiredReviewSnapshots — the pending gate', () => {
  /**
   * 🔴 THE gate. Sequence this reproduces: v1 submitted → rejected 40 days ago;
   * v2 submitted yesterday and is still pending. The snapshot repo now holds
   * v2's source. Purging on v1's rejection would delete the in-flight review.
   */
  it('does NOT delete when a pending request exists for the same slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockFindFirst.mockResolvedValue({ id: 'pubreq_v2_pending' });

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(result.skippedPending).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('DOES delete when no pending request exists for the slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockFindFirst.mockResolvedValue(null);

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledWith('gen-matrix');
    expect(result.deleted).toBe(1);
    expect(result.skippedPending).toBe(0);
  });

  it('gates per SLUG, not per row — a pending sibling protects only its own slug', async () => {
    mockFindMany.mockResolvedValue([row('protected-app'), row('free-app')]);
    mockFindFirst.mockImplementation(async (args: { where: { slug: string } }) =>
      args.where.slug === 'protected-app' ? { id: 'pubreq_pending' } : null
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('free-app');
    expect(result.skippedPending).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it('queries the gate with status pending on the exact slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { slug: 'gen-matrix', status: 'pending' } })
    );
  });

  /**
   * The blocking row can be seconds old while the triggering row is 30+ days
   * old, so a lagging replica would hide exactly the row whose presence is
   * load-bearing. The gate must read the primary.
   */
  it('reads the gate from the PRIMARY, not the replica', async () => {
    const db = await import('~/server/db/client');
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    // The gate's findFirst is bound to dbWrite; dbRead exposes no findFirst at all.
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    expect(
      (db.dbRead.appBlockPublishRequest as Record<string, unknown>).findFirst
    ).toBeUndefined();
  });
});

describe('purgeExpiredReviewSnapshots — the 30-day retention boundary', () => {
  it('is a single named constant of exactly 30 days', () => {
    expect(REVIEW_SNAPSHOT_PURGE_AFTER_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('selects only rows that went terminal MORE than the window ago', async () => {
    mockFindMany.mockResolvedValue([]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const args = mockFindMany.mock.calls[0][0];
    const cutoff: Date = args.where.updatedAt.lt;
    expect(cutoff.getTime()).toBe(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS);
  });

  /**
   * The boundary is enforced by the query predicate, so this drives it through
   * a findMany mock that actually APPLIES the where-clause the sweep builds —
   * otherwise the assertion is tautological (it would pass for any window,
   * including zero). `due` and `notYetDue` straddle the 30-day mark by an hour.
   */
  it('purges a request that is due and RETAINS one an hour short of the window', async () => {
    const due = row('due-app', new Date(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS - 3600_000));
    const notYetDue = row(
      'not-due-app',
      new Date(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS + 3600_000)
    );
    mockFindMany.mockImplementation(async (args: { where: Record<string, any> }) =>
      [due, notYetDue].filter(
        (r) =>
          args.where.status.in.includes(r.status) &&
          r.updatedAt > args.where.updatedAt.gt &&
          r.updatedAt < args.where.updatedAt.lt
      )
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('due-app');
    expect(mockDelete).not.toHaveBeenCalledWith('not-due-app');
    expect(result.deleted).toBe(1);
  });

  /**
   * Same predicate-applying mock, walked forward in time: the row that was
   * retained above becomes eligible once the full window has elapsed. Proves
   * the boundary is a delay, not a permanent exclusion.
   */
  it('purges that same request once the full window HAS elapsed', async () => {
    const notYetDue = row(
      'not-due-app',
      new Date(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS + 3600_000)
    );
    mockFindMany.mockImplementation(async (args: { where: Record<string, any> }) =>
      [notYetDue].filter(
        (r) => r.updatedAt > args.where.updatedAt.gt && r.updatedAt < args.where.updatedAt.lt
      )
    );

    const later = new Date(NOW.getTime() + 2 * 3600_000);
    const result = await purgeExpiredReviewSnapshots({ now: later });

    expect(mockDelete).toHaveBeenCalledWith('not-due-app');
    expect(result.deleted).toBe(1);
  });

  it('only considers rejected/withdrawn — approved snapshots are out of scope', async () => {
    mockFindMany.mockResolvedValue([]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const statuses = mockFindMany.mock.calls[0][0].where.status.in;
    expect([...statuses].sort()).toEqual(['rejected', 'withdrawn']);
    expect(statuses).not.toContain('approved');
    expect(statuses).not.toContain('pending');
  });
});

describe('purgeExpiredReviewSnapshots — batching, resumability, resilience', () => {
  it('bounds the scan with the named batch size and takes oldest-first', async () => {
    mockFindMany.mockResolvedValue([]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const args = mockFindMany.mock.calls[0][0];
    expect(args.take).toBe(REVIEW_SNAPSHOT_PURGE_BATCH_SIZE);
    expect(args.orderBy).toEqual({ updatedAt: 'asc' });
  });

  it('resumes from the stored cursor and advances it past the batch', async () => {
    const cursor = new Date('2026-01-01T00:00:00.000Z');
    const last = longAgo(1000);
    mockGetJobDate.mockResolvedValue([cursor, mockSetCursor]);
    mockFindMany.mockResolvedValue([row('a', longAgo(5000)), row('b', last)]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockFindMany.mock.calls[0][0].where.updatedAt.gt).toBe(cursor);
    expect(mockSetCursor).toHaveBeenCalledWith(last);
  });

  it('is a no-op (and leaves the cursor alone) when nothing is due', async () => {
    mockFindMany.mockResolvedValue([]);

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result).toMatchObject({ scanned: 0, candidates: 0, deleted: 0 });
    expect(mockDelete).not.toHaveBeenCalled();
    expect(mockSetCursor).not.toHaveBeenCalled();
  });

  it('dedupes to ONE delete per slug when several old requests share it', async () => {
    mockFindMany.mockResolvedValue([
      row('gen-matrix', longAgo(9000)),
      row('gen-matrix', longAgo(8000), 'withdrawn'),
      row('gen-matrix', longAgo(7000)),
    ]);

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(result.scanned).toBe(3);
    expect(result.candidates).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it('counts an already-gone repo as success, not failure (idempotent re-run)', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockDelete.mockResolvedValue('already-gone');

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result.alreadyGone).toBe(1);
    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('logs-and-continues past a per-repo failure', async () => {
    mockFindMany.mockResolvedValue([row('bad'), row('good')]);
    mockDelete.mockImplementation(async (slug: string) => {
      if (slug === 'bad') throw new Error('forgejo 500');
      return 'deleted';
    });

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(mockDelete).toHaveBeenCalledWith('good');
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'bad', outcome: 'failed', level: 'error' }),
      'webhooks'
    );
  });

  it('logs a per-repo outcome for every slug it acts on', async () => {
    mockFindMany.mockResolvedValue([row('a'), row('b')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const slugsLogged = mockLogToAxiom.mock.calls
      .map((c) => c[0] as { slug?: string })
      .filter((d) => !!d.slug)
      .map((d) => d.slug);
    expect(slugsLogged).toEqual(['a', 'b']);
  });
});

describe('purgeReviewSnapshotsJob wrapper', () => {
  it('returns the sweep result', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    const result = await (purgeReviewSnapshotsJob as unknown as () => Promise<{ deleted: number }>)();

    expect(result.deleted).toBe(1);
  });

  it('FAIL-OPEN: swallows a thrown sweep failure so the runner is never crashed', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));

    const result = await (purgeReviewSnapshotsJob as unknown as () => Promise<{
      error?: boolean;
      deleted: number;
    }>)();

    expect(result.error).toBe(true);
    expect(result.deleted).toBe(0);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'run-failed', level: 'error' }),
      'webhooks'
    );
  });

  it('stays silent on a no-op run', async () => {
    mockFindMany.mockResolvedValue([]);

    await (purgeReviewSnapshotsJob as unknown as () => Promise<unknown>)();

    expect(mockLogToAxiom).not.toHaveBeenCalled();
  });
});
