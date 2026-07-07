import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  getMyAppListingReview,
  listAppListingReviews,
  upsertAppListingReview,
} from '~/server/services/blocks/app-listing-review.service';
import { LISTING_REVIEW_DETAILS_MAX } from '~/server/schema/blocks/app-listing-review.schema';

/**
 * W13 — AppListing REVIEW (thumbs/recommend) service tests.
 *
 * Covers upsertReview (the SYNCHRONOUS metric-delta feed: new / details-only edit
 * / recommend flip; the non-negative clamp; the self-review + approved-only +
 * details-cap gates), getMyReview, and listReviews (mod-filter + keyset). All DB
 * deps are mocked — no real Prisma. `dbWrite.$transaction` runs its callback
 * against the SAME `dbWrite` mock (the tx client) so a test asserts the exact
 * metric writes made inside the tx. `dbRead`/`dbWrite` are DISTINCT mocks so a
 * test proves the listing load went to the replica and the writes to the primary.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListingReview: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  appListingMetric: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReview: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
};

const SAVED_REVIEW = {
  id: 7,
  appListingId: 'apl_target',
  userId: 42,
  recommended: true,
  details: null,
  createdAt: new Date('2026-07-07T00:00:00Z'),
  updatedAt: new Date('2026-07-07T00:00:00Z'),
};

const { mockRead, mockWrite } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListingReview: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => SAVED_REVIEW),
    },
    appListingMetric: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReview: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
  };
  return { mockRead: read, mockWrite: write };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: vi.fn(async () => undefined) }));

const CALLER = 42;
const OWNER = 99;
const APP_ID = 'apl_target';

/** Approved listing owned by someone OTHER than the caller (reviewable). */
function reviewableListing() {
  return { id: APP_ID, userId: OWNER, status: 'approved' };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWrite.$transaction.mockImplementation(
    async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite)
  );
  mockWrite.appListingReview.findUnique.mockResolvedValue(null);
  mockWrite.appListingReview.upsert.mockResolvedValue(SAVED_REVIEW);
  mockWrite.appListingMetric.upsert.mockResolvedValue({});
  mockWrite.appListingMetric.updateMany.mockResolvedValue({ count: 0 });
  mockRead.appListing.findUnique.mockResolvedValue(reviewableListing());
  mockRead.appListingReview.findUnique.mockResolvedValue(null);
  mockRead.appListingReview.findMany.mockResolvedValue([]);
});

function metricUpsertArgs() {
  return mockWrite.appListingMetric.upsert.mock.calls[0][0] as {
    where: { appListingId: string };
    create: { thumbsUpCount: number; thumbsDownCount: number };
    update: {
      thumbsUpCount?: { increment: number };
      thumbsDownCount?: { increment: number };
    };
  };
}

describe('upsertAppListingReview — new review (no prior)', () => {
  it('recommend=true → +1 thumbsUp; creates the metric row (zeros) if absent; isNewReview', async () => {
    const res = await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: true },
    });

    expect(res.isNewReview).toBe(true);
    // Review written to the PRIMARY, keyed on (appListingId, userId), userId FORCED.
    const upsertArgs = mockWrite.appListingReview.upsert.mock.calls[0][0];
    expect(upsertArgs.where).toEqual({ appListingId_userId: { appListingId: APP_ID, userId: CALLER } });
    expect(upsertArgs.create).toMatchObject({ appListingId: APP_ID, userId: CALLER, recommended: true });

    // Metric: create ensures the row exists with +1; update path increments +1.
    const m = metricUpsertArgs();
    expect(m.where).toEqual({ appListingId: APP_ID });
    expect(m.create).toEqual({ appListingId: APP_ID, thumbsUpCount: 1, thumbsDownCount: 0 });
    expect(m.update).toEqual({ thumbsUpCount: { increment: 1 } });
    // No decrement → no clamp.
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
  });

  it('recommend=false → +1 thumbsDown', async () => {
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: false },
    });
    const m = metricUpsertArgs();
    expect(m.create).toEqual({ appListingId: APP_ID, thumbsUpCount: 0, thumbsDownCount: 1 });
    expect(m.update).toEqual({ thumbsDownCount: { increment: 1 } });
  });
});

describe('upsertAppListingReview — editing an existing review', () => {
  it('details-only edit (same recommend) does NOT touch the metric (no double-count)', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue({
      id: 7,
      recommended: true,
      exclude: false,
    });
    const res = await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: true, details: 'nice app' },
    });
    expect(res.isNewReview).toBe(false);
    expect(mockWrite.appListingReview.upsert).toHaveBeenCalledTimes(1);
    // Zero delta → no metric write at all.
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
  });

  it('flipping recommend true→false moves the count (−1 up, +1 down) and clamps up ≥0', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue({
      id: 7,
      recommended: true,
      exclude: false,
    });
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: false },
    });
    const m = metricUpsertArgs();
    // create clamps the down bucket to ≥0 (only reached if the row were absent).
    expect(m.create).toEqual({ appListingId: APP_ID, thumbsUpCount: 0, thumbsDownCount: 1 });
    expect(m.update).toEqual({
      thumbsUpCount: { increment: -1 },
      thumbsDownCount: { increment: 1 },
    });
    // A decrement fired → the defensive non-negative clamp runs for the up bucket.
    expect(mockWrite.appListingMetric.updateMany).toHaveBeenCalledWith({
      where: { appListingId: APP_ID, thumbsUpCount: { lt: 0 } },
      data: { thumbsUpCount: 0 },
    });
  });

  it('a mod-EXCLUDED prior review is treated as un-counted → editing it makes no delta', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue({
      id: 7,
      recommended: true,
      exclude: true,
    });
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: false },
    });
    // Prior didn't count (excluded) and the edit stays excluded → no counter change.
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
  });
});

describe('upsertAppListingReview — eligibility + input gates', () => {
  it('self-review is rejected (owner) with no write', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({ id: APP_ID, userId: CALLER, status: 'approved' });
    await expect(
      upsertAppListingReview({ userId: CALLER, input: { appListingId: APP_ID, recommended: true } })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a missing listing → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(null);
    await expect(
      upsertAppListingReview({ userId: CALLER, input: { appListingId: APP_ID, recommended: true } })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a non-approved (draft/removed/rejected) listing is not reviewable → BAD_REQUEST', async () => {
    for (const status of ['draft', 'pending', 'rejected', 'removed']) {
      mockRead.appListing.findUnique.mockResolvedValue({ id: APP_ID, userId: OWNER, status });
      await expect(
        upsertAppListingReview({ userId: CALLER, input: { appListingId: APP_ID, recommended: true } })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('details over the cap → BAD_REQUEST before any listing load', async () => {
    await expect(
      upsertAppListingReview({
        userId: CALLER,
        input: {
          appListingId: APP_ID,
          recommended: true,
          details: 'x'.repeat(LISTING_REVIEW_DETAILS_MAX + 1),
        },
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('trims details and stores null for whitespace-only', async () => {
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: true, details: '  loved it  ' },
    });
    expect(mockWrite.appListingReview.upsert.mock.calls[0][0].create.details).toBe('loved it');

    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: APP_ID, recommended: true, details: '   ' },
    });
    expect(mockWrite.appListingReview.upsert.mock.calls[1][0].create.details).toBeNull();
  });
});

describe('getMyAppListingReview', () => {
  it('returns the caller review from the replica', async () => {
    mockRead.appListingReview.findUnique.mockResolvedValue({
      id: 7,
      recommended: true,
      details: 'ok',
      createdAt: new Date(),
    });
    const res = await getMyAppListingReview(APP_ID, CALLER);
    expect(res).toMatchObject({ id: 7, recommended: true });
    expect(mockRead.appListingReview.findUnique.mock.calls[0][0].where).toEqual({
      appListingId_userId: { appListingId: APP_ID, userId: CALLER },
    });
  });

  it('returns null when the caller has no review', async () => {
    mockRead.appListingReview.findUnique.mockResolvedValue(null);
    expect(await getMyAppListingReview(APP_ID, CALLER)).toBeNull();
  });
});

describe('listAppListingReviews', () => {
  function row(id: number) {
    return {
      id,
      recommended: true,
      details: null,
      createdAt: new Date(),
      user: { id: 1, username: 'u', image: null },
    };
  }

  it('filters exclude + tosViolation, newest-first, off the replica', async () => {
    mockRead.appListingReview.findMany.mockResolvedValue([row(3), row(2), row(1)]);
    await listAppListingReviews({ appListingId: APP_ID, limit: 20 });
    const args = mockRead.appListingReview.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ appListingId: APP_ID, exclude: false, tosViolation: false });
    expect(args.orderBy).toEqual({ id: 'desc' });
  });

  it('gates on the listing being approved (reviews of a removed/rejected listing are not enumerable)', async () => {
    mockRead.appListingReview.findMany.mockResolvedValue([]);
    await listAppListingReviews({ appListingId: APP_ID, limit: 20 });
    const args = mockRead.appListingReview.findMany.mock.calls[0][0];
    // The relation filter is what makes a later-removed listing's reviews vanish (and a
    // missing listing return empty) — critical before the P2d public read cutover.
    expect(args.where).toMatchObject({ appListing: { is: { status: 'approved' } } });
  });

  it('emits a nextCursor when a full page + 1 comes back (keyset)', async () => {
    // limit 2 → take 3; return 3 rows → hasNext, cursor = last VISIBLE row id.
    mockRead.appListingReview.findMany.mockResolvedValue([row(5), row(4), row(3)]);
    const res = await listAppListingReviews({ appListingId: APP_ID, limit: 2 });
    expect(res.items.map((i) => i.id)).toEqual([5, 4]);
    expect(res.nextCursor).toBe(4);
  });

  it('no nextCursor on a short page; applies the cursor as id < cursor', async () => {
    mockRead.appListingReview.findMany.mockResolvedValue([row(2), row(1)]);
    const res = await listAppListingReviews({ appListingId: APP_ID, limit: 20, cursor: 3 });
    expect(res.nextCursor).toBeUndefined();
    expect(mockRead.appListingReview.findMany.mock.calls[0][0].where).toMatchObject({
      id: { lt: 3 },
    });
  });
});
