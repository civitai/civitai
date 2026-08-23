import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMyAppListingReview,
  listAppListingReviews,
  recommendMetricDelta,
  setAppListingReviewExclude,
  upsertAppListingReview,
} from '~/server/services/blocks/app-listing-review.service';

/**
 * W13 — the MODERATOR hide/un-hide control for an AppListing review
 * (`AppListingReview.exclude`) and its denormalized-counter bookkeeping.
 *
 * `AppListingMetric.thumbsUp/DownCount` has NO rollup job — it is exactly the sum
 * of the ±1 deltas its writers applied. So the properties under test are not
 * "does it set a boolean" but:
 *   1. a hide moves EXACTLY ONE counter by EXACTLY 1, in the bucket matching the
 *      row's `recommended`, and an un-hide moves it back;
 *   2. a NO-OP transition applies a ZERO delta and writes NOTHING — the property
 *      that makes a retry / double-submit / two-moderators-on-one-report safe;
 *   3. the flag flip and the counter move happen in ONE transaction, off the
 *      PRIMARY (a replica-lag read of `exclude` would decide the delta wrongly).
 *
 * All DB deps are mocked — no real Prisma. `dbWrite.$transaction` runs its callback
 * against the SAME `dbWrite` mock (the tx client) so a test asserts the exact writes
 * made inside the tx, and `dbRead`/`dbWrite` are DISTINCT mocks so a test can prove
 * which client a read went to.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListingReview: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
  };
  appListingMetric: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReview: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
};

const { mockRead, mockWrite, mockBust } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListingReview: {
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({})),
    },
    appListingMetric: {
      upsert: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReview: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
    },
  };
  return { mockRead: read, mockWrite: write, mockBust: vi.fn(async () => undefined) };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: mockBust }));

const REVIEW_ID = 7;
const APP_ID = 'apl_target';

/** A stored review row as the service selects it. */
function reviewRow(over: Partial<{ recommended: boolean; exclude: boolean }> = {}) {
  return {
    id: REVIEW_ID,
    appListingId: APP_ID,
    recommended: true,
    exclude: false,
    ...over,
  };
}

beforeEach(() => {
  // 🔴 resetAllMocks, NOT clearAllMocks. `mockClear` leaves the `mockResolvedValueOnce`
  // QUEUE intact, so a test that throws before consuming its queued values leaks them
  // into the NEXT test — which then runs against a row it never configured and can
  // pass or fail for a reason that has nothing to do with the code. (Observed for
  // real while measuring this file against the base branch.) Every implementation is
  // re-established immediately below, so the reset costs nothing.
  vi.resetAllMocks();
  mockBust.mockResolvedValue(undefined);
  mockWrite.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) =>
    cb(mockWrite)
  );
  mockWrite.appListingReview.findUnique.mockResolvedValue(reviewRow());
  mockWrite.appListingReview.update.mockResolvedValue({});
  mockWrite.appListingReview.upsert.mockResolvedValue({});
  mockWrite.appListingMetric.upsert.mockResolvedValue({});
  mockWrite.appListingMetric.updateMany.mockResolvedValue({ count: 0 });
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListingReview.findUnique.mockResolvedValue(null);
  mockRead.appListingReview.findFirst.mockResolvedValue(null);
  mockRead.appListingReview.findMany.mockResolvedValue([]);
});

function metricUpdateArgs() {
  return mockWrite.appListingMetric.upsert.mock.calls[0][0] as {
    where: { appListingId: string };
    create: { thumbsUpCount: number; thumbsDownCount: number };
    update: { thumbsUpCount?: { increment: number }; thumbsDownCount?: { increment: number } };
  };
}

// ---------------------------------------------------------------------------
// The shared delta rule, as a pure truth table.
//
// Both writers (`upsertAppListingReview` and `setAppListingReviewExclude`) route
// their arithmetic through this one function, so pinning it here pins BOTH. The
// cases are chosen so each is distinguishable from the others: a mutant that
// hardcodes a bucket, drops a sign, or collapses the two branches breaks at least
// one row.
// ---------------------------------------------------------------------------
describe('recommendMetricDelta — the one delta rule, both writers share it', () => {
  it.each([
    // [label, prior contribution, next contribution, expected delta]
    ['nothing → nothing (no-op)', null, null, { upDelta: 0, downDelta: 0 }],
    [
      'nothing → recommend (new/unhidden up)',
      null,
      { recommended: true },
      { upDelta: 1, downDelta: 0 },
    ],
    [
      'nothing → not-recommend (new/unhidden down)',
      null,
      { recommended: false },
      { upDelta: 0, downDelta: 1 },
    ],
    [
      'recommend → nothing (hide an up)',
      { recommended: true },
      null,
      { upDelta: -1, downDelta: 0 },
    ],
    [
      'not-recommend → nothing (hide a down)',
      { recommended: false },
      null,
      { upDelta: 0, downDelta: -1 },
    ],
    [
      'recommend → recommend (details-only edit)',
      { recommended: true },
      { recommended: true },
      { upDelta: 0, downDelta: 0 },
    ],
    [
      'not-recommend → not-recommend (details-only edit)',
      { recommended: false },
      { recommended: false },
      { upDelta: 0, downDelta: 0 },
    ],
    [
      'recommend → not-recommend (flip)',
      { recommended: true },
      { recommended: false },
      { upDelta: -1, downDelta: 1 },
    ],
    [
      'not-recommend → recommend (flip)',
      { recommended: false },
      { recommended: true },
      { upDelta: 1, downDelta: -1 },
    ],
  ])('%s', (_label, prior, next, expected) => {
    expect(recommendMetricDelta(prior, next)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// HIDING — false → true.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — hiding (false → true)', () => {
  it('a RECOMMENDED review: sets exclude and decrements thumbsUp by exactly 1', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: true, exclude: false })
    );

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: true, changed: true });
    expect(mockWrite.appListingReview.update).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      data: { exclude: true },
    });

    const m = metricUpdateArgs();
    expect(m.where).toEqual({ appListingId: APP_ID });
    // EXACTLY ONE counter moves, by EXACTLY 1 — the down bucket key must be ABSENT,
    // not merely zero (an `{ increment: 0 }` would still bump `updatedAt`).
    expect(m.update).toEqual({ thumbsUpCount: { increment: -1 } });
    expect(m.update.thumbsDownCount).toBeUndefined();
    // A decrement fired → the defensive non-negative clamp runs for that bucket only.
    expect(mockWrite.appListingMetric.updateMany).toHaveBeenCalledWith({
      where: { appListingId: APP_ID, thumbsUpCount: { lt: 0 } },
      data: { thumbsUpCount: 0 },
    });
    expect(mockWrite.appListingMetric.updateMany).toHaveBeenCalledTimes(1);
  });

  it('a NOT-RECOMMENDED review: decrements thumbsDown by exactly 1 (the other counter)', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: false, exclude: false })
    );

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    const m = metricUpdateArgs();
    expect(m.update).toEqual({ thumbsDownCount: { increment: -1 } });
    expect(m.update.thumbsUpCount).toBeUndefined();
    expect(mockWrite.appListingMetric.updateMany).toHaveBeenCalledWith({
      where: { appListingId: APP_ID, thumbsDownCount: { lt: 0 } },
      data: { thumbsDownCount: 0 },
    });
    expect(mockWrite.appListingMetric.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// UN-HIDING — true → false.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — un-hiding (true → false)', () => {
  it('a RECOMMENDED review: clears exclude and re-increments thumbsUp by exactly 1', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: true, exclude: true })
    );

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: false, changed: true });
    expect(mockWrite.appListingReview.update).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      data: { exclude: false },
    });

    const m = metricUpdateArgs();
    expect(m.update).toEqual({ thumbsUpCount: { increment: 1 } });
    expect(m.update.thumbsDownCount).toBeUndefined();
    // No decrement anywhere → the clamp must NOT run.
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
  });

  it('a NOT-RECOMMENDED review: re-increments thumbsDown by exactly 1', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: false, exclude: true })
    );

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    const m = metricUpdateArgs();
    expect(m.update).toEqual({ thumbsDownCount: { increment: 1 } });
    expect(m.update.thumbsUpCount).toBeUndefined();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
  });

  it('hide-then-unhide of the same row returns the counter to where it started (round trip)', async () => {
    // Two calls against the row's two states; the deltas must sum to zero on the
    // bucket that moved, and never touch the other bucket.
    mockWrite.appListingReview.findUnique.mockResolvedValueOnce(
      reviewRow({ recommended: true, exclude: false })
    );
    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    mockWrite.appListingReview.findUnique.mockResolvedValueOnce(
      reviewRow({ recommended: true, exclude: true })
    );
    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    const calls = mockWrite.appListingMetric.upsert.mock.calls.map(
      (c) => (c[0] as { update: { thumbsUpCount?: { increment: number } } }).update
    );
    expect(calls).toEqual([
      { thumbsUpCount: { increment: -1 } },
      { thumbsUpCount: { increment: 1 } },
    ]);
    const net = calls.reduce((sum, u) => sum + (u.thumbsUpCount?.increment ?? 0), 0);
    expect(net).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IDEMPOTENCE — the case most likely to be wrong, and what makes a re-run safe.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — a NO-OP transition applies ZERO delta', () => {
  it('hiding an ALREADY-hidden review writes nothing at all (no row update, no counter, no bust)', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: true, exclude: true })
    );

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: true, changed: false });
    expect(mockWrite.appListingReview.update).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('un-hiding an already-VISIBLE review writes nothing at all', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: false, exclude: false })
    );

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    expect(res).toMatchObject({ exclude: false, changed: false });
    expect(mockWrite.appListingReview.update).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('hiding TWICE moves the counter exactly ONCE (a retry cannot double-count)', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValueOnce(
      reviewRow({ recommended: true, exclude: false })
    );
    const first = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    // Second call sees the row in its NEW state — the realistic retry.
    mockWrite.appListingReview.findUnique.mockResolvedValueOnce(
      reviewRow({ recommended: true, exclude: true })
    );
    const second = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(mockWrite.appListingMetric.upsert).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingReview.update).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Atomicity + not-found.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — transaction + lookup', () => {
  it('reads the row and writes BOTH the flag and the counter inside ONE transaction, on the PRIMARY', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: true, exclude: false })
    );

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    // The `exclude` read decides the delta, so it must NOT come off the replica —
    // a lagging read would recompute a delta that was already applied.
    expect(mockRead.appListingReview.findUnique).not.toHaveBeenCalled();
    expect(mockRead.appListingReview.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListingReview.findUnique).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      select: { id: true, appListingId: true, recommended: true, exclude: true },
    });
  });

  it('a missing review → NOT_FOUND, with no row or counter write', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(null);

    await expect(
      setAppListingReviewExclude({ reviewId: 12345, exclude: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockWrite.appListingReview.update).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('a real transition busts the store-wide recommend-mean cache', async () => {
    mockWrite.appListingReview.findUnique.mockResolvedValue(
      reviewRow({ recommended: true, exclude: false })
    );
    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    expect(mockBust).toHaveBeenCalledWith(['app-listing:recommend-global-mean']);
  });
});

// ---------------------------------------------------------------------------
// SEAM: the user write path and the mod path share one delta rule.
//
// Verifying each in isolation cannot see a disagreement BETWEEN them, so this
// asserts the relationship: the same (recommended, excluded) state produces the
// same counter language from both writers.
//
// 🟡 LABEL: green at the base commit too — the user path already honoured a
// pre-existing `exclude`. It is an INVARIANT GUARD, not regression coverage: it
// pins the property the mod control now DEPENDS on (a hidden review stays hidden
// from the aggregate when its author edits it), which nothing asserted before
// anything could set `exclude` in the first place.
// ---------------------------------------------------------------------------
describe('seam — the user write path still routes through the shared rule', () => {
  it('a mod-EXCLUDED prior review stays un-counted when its author edits it (no delta)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({
      id: APP_ID,
      userId: 99,
      status: 'approved',
    });
    mockWrite.appListingReview.findUnique.mockResolvedValue({
      id: REVIEW_ID,
      recommended: true,
      exclude: true,
    });
    mockWrite.appListingReview.upsert.mockResolvedValue({
      id: REVIEW_ID,
      appListingId: APP_ID,
      userId: 42,
      recommended: false,
      details: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await upsertAppListingReview({
      userId: 42,
      input: { appListingId: APP_ID, recommended: false },
      scope: 'full',
    });

    // An author cannot restore their own hidden review to the aggregate by editing
    // it — the mod decision survives the edit.
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// READ-PATH INVARIANT GUARDS.
//
// 🟡 LABEL: these two pin behaviour that ALREADY holds on `main`. They are
// INVARIANT GUARDS, not regression coverage for this change — they are green
// before it and after it. They exist because the mod control makes both properties
// load-bearing for the first time: hiding a review must remove it from the public
// list, and must NOT remove it from its own author's edit form.
// ---------------------------------------------------------------------------
describe('read-path invariants the mod control depends on', () => {
  it('INVARIANT: getMyAppListingReview does NOT filter exclude — an author still sees their hidden review', async () => {
    mockRead.appListingReview.findFirst.mockResolvedValue({
      id: REVIEW_ID,
      recommended: true,
      details: 'hidden but mine',
      createdAt: new Date(),
    });

    const res = await getMyAppListingReview(APP_ID, 42, { scope: 'full' });

    // The row comes back even though the mod hid it...
    expect(res).toMatchObject({ id: REVIEW_ID, details: 'hidden but mine' });
    // ...because the query carries NO `exclude` predicate. Deliberate: this is the
    // edit-form prefill, and blanking it would invite a "new" review that the DB
    // unique silently turns into an update of the row they cannot see.
    const where = mockRead.appListingReview.findFirst.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    expect(where).not.toHaveProperty('exclude');
    expect(where).not.toHaveProperty('tosViolation');
    expect(where).toMatchObject({ appListingId: APP_ID, userId: 42 });
  });

  it('INVARIANT: listAppListingReviews DOES filter exclude — a hidden review leaves the public list', async () => {
    mockRead.appListingReview.findMany.mockResolvedValue([]);

    await listAppListingReviews({ appListingId: APP_ID, limit: 20 }, { scope: 'full' });

    const where = mockRead.appListingReview.findMany.mock.calls[0][0].where as Record<
      string,
      unknown
    >;
    // `exclude: false` is what makes the mod action take effect on the visible list
    // with no read-path change. Assert the exact value, not merely the key.
    expect(where.exclude).toBe(false);
    expect(where.tosViolation).toBe(false);
  });
});
