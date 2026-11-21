import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Coverage for the in-review snapshot retention sweep.
 *
 * The two properties that MUST hold, because getting either wrong destroys work
 * a moderator or developer is relying on:
 *  1. THE PROTECTION GATE — snapshots are keyed per-slug and overwritten on every
 *     submit, and a terminal request does not reserve its slug, so a purge
 *     triggered by an old rejected request must NOT delete a snapshot that a
 *     different request for the same slug — pending OR approved, and possibly a
 *     different owner's — currently holds.
 *  2. THE 30-DAY BOUNDARY — a request that went terminal less than
 *     REVIEW_SNAPSHOT_PURGE_AFTER_MS ago is retained, not reclaimed.
 */

const { mockDelete, mockGetJobDate, mockSetCursor } = vi.hoisted(() => ({
  mockDelete: vi.fn(),
  mockGetJobDate: vi.fn(),
  mockSetCursor: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('~/server/services/blocks/forgejo.service', () => ({
  deleteReviewRepo: (...a: unknown[]) => mockDelete(...a),
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
  PURGEABLE_TERMINAL_STATUSES,
  REVIEW_SNAPSHOT_PURGE_AFTER_MS,
  REVIEW_SNAPSHOT_PURGE_BATCH_SIZE,
  SNAPSHOT_PROTECTING_STATUSES,
} from '../purge-review-snapshots';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
const mockFindMany = dbMock.dbRead.appBlockPublishRequest.findMany;
const mockFindFirst = dbMock.dbWrite.appBlockPublishRequest.findFirst;
const mockLogToAxiom = loggingMock.logToAxiom;

/** The DB pins this vocabulary: CHECK ("status" IN (…)) on the request table. */
const ALL_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;

const NOW = new Date('2026-07-31T00:00:00.000Z');
/** Terminal exactly this long ago = comfortably past the retention window. */
const longAgo = (extraMs = 24 * 60 * 60 * 1000) =>
  new Date(NOW.getTime() - REVIEW_SNAPSHOT_PURGE_AFTER_MS - extraMs);

type Row = { id: string; slug: string; status: string; updatedAt: Date };
/** The shape of the where-clause the sweep builds, for predicate-applying mocks. */
type UpdatedAtFilter = { gt?: Date; gte?: Date; lt: Date };
type PurgeWhere = { status: { in: string[] }; updatedAt: UpdatedAtFilter };
/**
 * Applies the sweep's `updatedAt` filter the way Postgres would, at MICROSECOND
 * resolution (the column is `timestamptz(6)`). Prisma binds a JS `Date`, which
 * only carries milliseconds, so each bound is `ms * 1000` microseconds. Honours
 * whichever of `gt`/`gte` the sweep sends, so it reports what that query
 * actually matches rather than assuming one operator.
 */
const matchesUpdatedAt = (rowMicros: number, f: UpdatedAtFilter) =>
  (f.gt === undefined || rowMicros > f.gt.getTime() * 1000) &&
  (f.gte === undefined || rowMicros >= f.gte.getTime() * 1000) &&
  rowMicros < f.lt.getTime() * 1000;
const micros = (d: Date) => d.getTime() * 1000;
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

/**
 * A `findFirst` mock that APPLIES the gate's where-clause against a fake table.
 * Load-bearing: a mock that returns a blocking row unconditionally would pass
 * for ANY status filter — including one that has stopped covering a status the
 * gate is supposed to protect — so the predicate has to be evaluated for real.
 */
const gateOver =
  (table: Array<{ id: string; slug: string; status: string }>) =>
  async (args: { where: { slug: string; status: string | { in: string[] } } }) => {
    const { slug, status } = args.where;
    const matches = (s: string) =>
      typeof status === 'string' ? status === s : status.in.includes(s);
    return table.find((r) => r.slug === slug && matches(r.status)) ?? null;
  };

describe('purgeExpiredReviewSnapshots — the protection gate', () => {
  /**
   * 🔴 THE gate. Sequence this reproduces: v1 submitted → rejected 40 days ago;
   * v2 submitted yesterday and is still pending. The snapshot repo now holds
   * v2's source. Purging on v1's rejection would delete the in-flight review.
   */
  it('does NOT delete when a pending request exists for the same slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockFindFirst.mockImplementation(
      gateOver([{ id: 'pubreq_v2_pending', slug: 'gen-matrix', status: 'pending' }])
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(result.skippedProtected).toBe(1);
    expect(result.deleted).toBe(0);
  });

  /**
   * 🔴 The same gate, one status over. A terminal request does NOT reserve its
   * slug, so after A's rejection ages out the slug can have been taken by B and
   * approved — at which point the snapshot holds B's live source, not A's. The
   * file-level comment says approved snapshots are out of scope for this sweep;
   * this is the assertion that makes that true of the CODE and not just of the
   * eligibility list (which only decides which rows TRIGGER a purge).
   */
  it('does NOT delete when an APPROVED request owns the slug (different-owner takeover)', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]); // user A, rejected 31d ago
    mockFindFirst.mockImplementation(
      gateOver([{ id: 'pubreq_b_approved', slug: 'gen-matrix', status: 'approved' }])
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).not.toHaveBeenCalled();
    expect(result.skippedProtected).toBe(1);
    expect(result.deleted).toBe(0);
  });

  it('DOES delete when only terminal requests exist for the slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockFindFirst.mockImplementation(
      gateOver([
        { id: 'pubreq_old_rejected', slug: 'gen-matrix', status: 'rejected' },
        { id: 'pubreq_old_withdrawn', slug: 'gen-matrix', status: 'withdrawn' },
      ])
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledWith('gen-matrix');
    expect(result.deleted).toBe(1);
    expect(result.skippedProtected).toBe(0);
  });

  it('gates per SLUG, not per row — a protecting sibling protects only its own slug', async () => {
    mockFindMany.mockResolvedValue([row('protected-app'), row('free-app')]);
    mockFindFirst.mockImplementation(
      gateOver([{ id: 'pubreq_pending', slug: 'protected-app', status: 'pending' }])
    );

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith('free-app');
    expect(result.skippedProtected).toBe(1);
    expect(result.deleted).toBe(1);
  });

  it('queries the gate for every protecting status on the exact slug', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const where = mockFindFirst.mock.calls[0][0].where;
    expect(where.slug).toBe('gen-matrix');
    expect([...where.status.in].sort()).toEqual(['approved', 'pending']);
  });

  /**
   * The two sets are meant to PARTITION the closed status vocabulary, which is
   * what lets the gate be read as "not terminal for this sweep". A new status
   * (or a status moved between the lists) that breaks the partition would leave
   * a value that is neither purgeable nor protecting — a silent gap.
   */
  it('the purgeable and protecting sets partition the closed status vocabulary', () => {
    const purgeable = [...PURGEABLE_TERMINAL_STATUSES] as string[];
    const protecting = [...SNAPSHOT_PROTECTING_STATUSES] as string[];
    expect([...purgeable, ...protecting].sort()).toEqual([...ALL_STATUSES].sort());
    expect(purgeable.filter((s) => protecting.includes(s))).toEqual([]);
  });

  /**
   * The blocking row can be seconds old while the triggering row is 30+ days
   * old, so a lagging replica would hide exactly the row whose presence is
   * load-bearing. The gate must read the primary.
   */
  it('reads the gate from the PRIMARY, not the replica', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    // Every gate read (the pre-delete gate + the post-delete re-check) is bound to
    // dbWrite, and the replica is never asked. Asserted as "was not called" rather than
    // "the method is undefined": the canonical mock vivifies every method, so absence
    // from the fixture is no longer observable — and a call count is the stronger claim
    // anyway, since it would still catch a read routed to the replica if some other file
    // had populated that method first.
    expect(mockFindFirst).toHaveBeenCalledTimes(2);
    expect(dbMock.dbRead.appBlockPublishRequest.findFirst).not.toHaveBeenCalled();
  });
});

/**
 * The gate cannot be perfectly tight: submit writes the snapshot before it
 * inserts the row that protects it, so a submission starting between the gate
 * read and the delete is invisible to the gate. The re-check does not close that
 * window — it converts a silent broken review into a loud, actionable log line.
 */
describe('purgeExpiredReviewSnapshots — post-delete re-check', () => {
  /** Gate read #1 sees nothing; the re-check (call #2) sees a new pending row. */
  const raceAfterDelete = (pendingId: string) => {
    let call = 0;
    mockFindFirst.mockImplementation(async () => (++call === 1 ? null : { id: pendingId }));
  };

  it('logs at error level when a pending request appears after the delete', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    raceAfterDelete('pubreq_raced');

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result.deleted).toBe(1);
    expect(mockLogToAxiom).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'gen-matrix',
        outcome: 'deleted-under-new-submission',
        pendingId: 'pubreq_raced',
        level: 'error',
      }),
      'webhooks'
    );
  });

  it('stays quiet on the normal path — no error log when nothing raced', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    await purgeExpiredReviewSnapshots({ now: NOW });

    const outcomes = mockLogToAxiom.mock.calls.map((c) => (c[0] as { outcome?: string }).outcome);
    expect(outcomes).not.toContain('deleted-under-new-submission');
    expect(outcomes).not.toContain('failed');
  });

  it('does not re-check (or warn) when the repo was already gone', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);
    mockDelete.mockResolvedValue('already-gone');
    raceAfterDelete('pubreq_raced');

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    // Nothing was destroyed, so there is nothing to warn about: only the gate ran.
    expect(result.alreadyGone).toBe(1);
    expect(mockFindFirst).toHaveBeenCalledTimes(1);
    const outcomes = mockLogToAxiom.mock.calls.map((c) => (c[0] as { outcome?: string }).outcome);
    expect(outcomes).not.toContain('deleted-under-new-submission');
  });
});

describe('purgeExpiredReviewSnapshots — cancellation', () => {
  /**
   * The webhook drops this job's run-lock when its HTTP request closes, so the
   * loop must stop rather than keep deleting past the lock.
   */
  it('stops the loop when the job context reports cancellation', async () => {
    mockFindMany.mockResolvedValue([row('a'), row('b'), row('c')]);
    let seen = 0;
    const jobContext = {
      checkIfCanceled: () => {
        if (++seen > 1) throw new Error('Job was canceled');
      },
    };

    await expect(purgeExpiredReviewSnapshots({ now: NOW, jobContext })).rejects.toThrow(
      'Job was canceled'
    );

    // First slug processed, then the cancel stopped it — and because the sweep
    // never reached the cursor write, the batch is simply re-walked next run.
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockSetCursor).not.toHaveBeenCalled();
  });

  /**
   * The cancel check sits OUTSIDE the per-slug try/catch. If it were inside, the
   * per-repo "log and continue" handler would swallow it and the loop would run
   * to completion — exactly what cancellation is supposed to prevent.
   */
  it('does not absorb the cancellation as a per-slug failure', async () => {
    mockFindMany.mockResolvedValue([row('a'), row('b'), row('c')]);
    const jobContext = {
      checkIfCanceled: () => {
        throw new Error('Job was canceled');
      },
    };

    await expect(purgeExpiredReviewSnapshots({ now: NOW, jobContext })).rejects.toThrow(
      'Job was canceled'
    );
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('runs to completion when no job context is supplied', async () => {
    mockFindMany.mockResolvedValue([row('a'), row('b')]);

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result.deleted).toBe(2);
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
  it('purges a request terminal 31 days ago and RETAINS one terminal 29 days ago', async () => {
    // ABSOLUTE dates, deliberately not derived from the constant: fixtures
    // expressed relative to REVIEW_SNAPSHOT_PURGE_AFTER_MS move with it, so
    // they would straddle the boundary for ANY window value including zero.
    const due = row('due-app', new Date('2026-06-30T00:00:00.000Z')); // 31d before NOW
    const notYetDue = row('not-due-app', new Date('2026-07-02T00:00:00.000Z')); // 29d before NOW
    mockFindMany.mockImplementation(async (args: { where: PurgeWhere }) =>
      [due, notYetDue].filter(
        (r) =>
          args.where.status.in.includes(r.status) &&
          matchesUpdatedAt(micros(r.updatedAt), args.where.updatedAt)
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
  it('purges that same 29-day-old request once the clock reaches day 31', async () => {
    const notYetDue = row('not-due-app', new Date('2026-07-02T00:00:00.000Z'));
    mockFindMany.mockImplementation(async (args: { where: PurgeWhere }) =>
      [notYetDue].filter(
        (r) => matchesUpdatedAt(micros(r.updatedAt), args.where.updatedAt)
      )
    );

    const later = new Date('2026-08-02T00:00:00.000Z'); // 31d after the decision
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

    // Resumes at the millisecond AFTER the stored cursor (see the precision test below).
    expect(mockFindMany.mock.calls[0][0].where.updatedAt.gte).toEqual(
      new Date('2026-01-01T00:00:00.001Z')
    );
    expect(mockSetCursor).toHaveBeenCalledWith(last);
  });

  /**
   * Regression: the cursor is persisted as epoch MILLISECONDS but `updatedAt` is
   * `timestamptz(6)`. A last row at `…:05.356842` saves the cursor as `…:05.356`,
   * and a `gt` resume matches that same row again — every run, for as long as
   * it is the newest due row. Drives two consecutive runs through a findMany mock
   * that applies the filter at microsecond resolution and round-trips the
   * cursor exactly as `getJobDate` does (`new Date(storedEpochMs)`).
   */
  it('advances past a last row with a sub-millisecond updatedAt (ms cursor vs µs column)', async () => {
    // 2026-06-01T00:00:05.356842Z — 356 ms + 842 µs past the second.
    const subMsMicros = Date.parse('2026-06-01T00:00:05.356Z') * 1000 + 842;
    const table = [{ id: 'pubreq_subms', slug: 'sub-ms-app', status: 'rejected', micros: subMsMicros }];
    mockFindMany.mockImplementation(async (args: { where: PurgeWhere }) =>
      table
        .filter(
          (r) =>
            args.where.status.in.includes(r.status) && matchesUpdatedAt(r.micros, args.where.updatedAt)
        )
        // What Prisma hands back: a JS Date, truncated to the millisecond.
        .map((r) => ({ ...r, updatedAt: new Date(Math.floor(r.micros / 1000)) }))
    );

    // Run 1: fresh cursor, the row is due and gets reclaimed.
    const first = await purgeExpiredReviewSnapshots({ now: NOW });
    expect(first.scanned).toBe(1);
    expect(mockSetCursor).toHaveBeenCalledTimes(1);
    const savedMs = (mockSetCursor.mock.calls[0] as unknown as [Date])[0].getTime();
    expect(savedMs).toBe(Date.parse('2026-06-01T00:00:05.356Z'));

    // Run 2: resume from the persisted epoch-ms value, as getJobDate would.
    mockGetJobDate.mockResolvedValue([new Date(savedMs), mockSetCursor]);
    mockDelete.mockClear();
    const second = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(second.scanned).toBe(0);
    expect(mockDelete).not.toHaveBeenCalled();
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

  it('continues past a per-repo failure', async () => {
    mockFindMany.mockResolvedValue([row('bad'), row('good')]);
    mockDelete.mockImplementation(async (slug: string) => {
      if (slug === 'bad') throw new Error('forgejo 500');
      return 'deleted';
    });

    const result = await purgeExpiredReviewSnapshots({ now: NOW });

    expect(result.failed).toBe(1);
    expect(result.deleted).toBe(1);
    expect(mockDelete).toHaveBeenCalledWith('good');
  });
});

describe('purgeReviewSnapshotsJob wrapper', () => {
  it('returns the sweep result', async () => {
    mockFindMany.mockResolvedValue([row('gen-matrix')]);

    const result = await (
      purgeReviewSnapshotsJob as unknown as () => Promise<{ deleted: number }>
    )();

    expect(result.deleted).toBe(1);
  });

  it('FAIL-OPEN: swallows a thrown sweep failure so the runner is never crashed', async () => {
    mockFindMany.mockRejectedValue(new Error('db down'));

    const result = await (
      purgeReviewSnapshotsJob as unknown as () => Promise<{
        error?: boolean;
        deleted: number;
      }>
    )();

    expect(result.error).toBe(true);
    expect(result.deleted).toBe(0);
  });
});
