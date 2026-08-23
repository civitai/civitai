import { globSync, readFileSync } from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMyAppListingReview,
  listAppListingReviews,
  recommendMetricDelta,
  setAppListingReviewExclude,
  upsertAppListingReview,
} from '~/server/services/blocks/app-listing-review.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { resetHybridNodes } from '~/__tests__/mocks/hybrid';

/**
 * W13 — the MODERATOR hide/un-hide control for an AppListing review
 * (`AppListingReview.exclude`) and its denormalized-counter bookkeeping.
 *
 * `AppListingMetric.thumbsUp/DownCount` is denormalized and nothing recomputes it —
 * it is exactly the sum of the ±1 deltas its writers applied. So the properties
 * under test are not "does it set a boolean" but:
 *   1. a hide moves EXACTLY ONE counter by EXACTLY 1, in the bucket matching the
 *      row's `recommended`, and an un-hide moves it back;
 *   2. a transition that WE did not perform — already in the target state, or a
 *      concurrent racer got there first — applies a ZERO delta and writes nothing;
 *   3. the flag flip and the counter move happen INSIDE one transaction, on the
 *      PRIMARY (a replica-lag read of `exclude` would decide the delta wrongly);
 *   4. the set of functions allowed to write those counters is fixed.
 *
 * All DB deps come from the CANONICAL `dbMock` (registered globally in
 * `src/__tests__/setup.ts`) — no real Prisma, and no per-file `vi.mock` of
 * `~/server/db/client`, which `no-direct-shared-module-mock` forbids. `dbRead` and
 * `dbWrite` are DISTINCT nodes, so a test can prove which client a read went to.
 *
 * 🔴 THE TX CLIENT IS A SEPARATE SENTINEL OBJECT, not `dbMock.dbWrite`.
 * The canonical `$transaction` default hands the callback `dbMock.dbWrite` itself,
 * which makes `tx.x.y()` and `dbWrite.x.y()` land on the SAME spy — so a test can
 * assert a call happened but NOT that it happened inside the transaction, and a
 * change that moved a write out of the tx would stay green. Overriding the default
 * to pass `txMock` gives the two paths different spies: every in-tx assertion below
 * is against `txMock`, and `outOfTxWrites` pins that the non-transactional client
 * was never touched.
 */

const { mockBust } = vi.hoisted(() => ({ mockBust: vi.fn(async () => undefined) }));
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: mockBust }));

/**
 * The sentinel transaction client. Distinct identities from `dbMock.dbWrite`, so
 * "inside the tx" is observable rather than assumed.
 */
const txMock = {
  $queryRaw: vi.fn(),
  appListingReview: {
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  },
  appListingMetric: { upsert: vi.fn(), updateMany: vi.fn() },
};

/** The same method names on the NON-transactional client — must stay untouched. */
const outOfTxWrites = [
  dbMock.dbWrite.appListingReview.findUnique,
  dbMock.dbWrite.appListingReview.update,
  dbMock.dbWrite.appListingReview.updateMany,
  dbMock.dbWrite.appListingReview.upsert,
  dbMock.dbWrite.appListingMetric.upsert,
  dbMock.dbWrite.appListingMetric.updateMany,
];

const mockWrite = txMock;
const mockRead = {
  appListing: { findUnique: dbMock.dbRead.appListing.findUnique },
  appListingReview: {
    findUnique: dbMock.dbRead.appListingReview.findUnique,
    findFirst: dbMock.dbRead.appListingReview.findFirst,
    findMany: dbMock.dbRead.appListingReview.findMany,
  },
};

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

/**
 * Arm the mod-hide path for a row in `before`, transitioning to `target`.
 *
 * The conditional UPDATE is the guard, so the DB — not the service — decides whether
 * a transition happened. `won` models `count`: 1 = we transitioned it, 0 = it was
 * already in the target state OR a concurrent racer beat us to it.
 */
function armExcludeRow(
  before: { recommended: boolean; exclude: boolean },
  opts: { won: boolean; observedAfter?: boolean } = { won: true }
) {
  txMock.appListingReview.updateMany.mockResolvedValue({ count: opts.won ? 1 : 0 });
  txMock.appListingReview.findUnique.mockResolvedValue(
    reviewRow({
      recommended: before.recommended,
      exclude: opts.observedAfter ?? (opts.won ? !before.exclude : before.exclude),
    })
  );
}

beforeEach(() => {
  // 🔴 A full RESET, not `mockClear`. `mockClear` leaves the `mockResolvedValueOnce`
  // QUEUE intact, so a test that throws before consuming its queued values leaks them
  // into the NEXT test — which then runs against a row it never configured and can pass
  // or fail for a reason that has nothing to do with the code. (Observed for real while
  // measuring this file against the base branch.) `resetSharedMocks()` runs per FILE,
  // not per test, so the per-test reset has to be explicit — `resetHybridNodes()` clears
  // every canonical node's implementation AND call history and re-applies its registered
  // default, which the override below then replaces.
  resetHybridNodes();
  for (const spy of Object.values(txMock)) {
    if (typeof spy === 'function') spy.mockReset();
    else for (const inner of Object.values(spy)) inner.mockReset();
  }
  mockBust.mockReset();
  mockBust.mockResolvedValue(undefined);

  // Hand the callback the SENTINEL client, not `dbMock.dbWrite`.
  dbMock.dbWrite.$transaction.mockImplementation(async (cb: unknown) =>
    typeof cb === 'function' ? (cb as (tx: unknown) => unknown)(txMock) : undefined
  );

  txMock.$queryRaw.mockResolvedValue([]);
  txMock.appListingReview.findUnique.mockResolvedValue(reviewRow());
  txMock.appListingReview.update.mockResolvedValue({});
  txMock.appListingReview.updateMany.mockResolvedValue({ count: 1 });
  txMock.appListingReview.upsert.mockResolvedValue({});
  txMock.appListingMetric.upsert.mockResolvedValue({});
  txMock.appListingMetric.updateMany.mockResolvedValue({ count: 0 });
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
    armExcludeRow({ recommended: true, exclude: false }, { won: true });

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: true, changed: true });
    // 🔴 The transition is the UPDATE's own predicate — `exclude: { not: target }` is
    // what makes the DB, not this process, decide who transitioned the row. A plain
    // `update({ where: { id } })` would re-open the read-then-branch race.
    expect(mockWrite.appListingReview.updateMany).toHaveBeenCalledWith({
      where: { id: REVIEW_ID, exclude: { not: true } },
      data: { exclude: true },
    });
    // An unconditional update must NOT be how this is done.
    expect(mockWrite.appListingReview.update).not.toHaveBeenCalled();

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
    armExcludeRow({ recommended: false, exclude: false }, { won: true });

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
    armExcludeRow({ recommended: true, exclude: true }, { won: true });

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: false, changed: true });
    expect(mockWrite.appListingReview.updateMany).toHaveBeenCalledWith({
      where: { id: REVIEW_ID, exclude: { not: false } },
      data: { exclude: false },
    });
    expect(mockWrite.appListingReview.update).not.toHaveBeenCalled();

    const m = metricUpdateArgs();
    expect(m.update).toEqual({ thumbsUpCount: { increment: 1 } });
    expect(m.update.thumbsDownCount).toBeUndefined();
    // No decrement anywhere → the clamp must NOT run.
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
  });

  it('a NOT-RECOMMENDED review: re-increments thumbsDown by exactly 1', async () => {
    armExcludeRow({ recommended: false, exclude: true }, { won: true });

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    const m = metricUpdateArgs();
    expect(m.update).toEqual({ thumbsDownCount: { increment: 1 } });
    expect(m.update.thumbsUpCount).toBeUndefined();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
  });

  it('hide-then-unhide of the same row returns the counter to where it started (round trip)', async () => {
    // Two calls against the row's two states; the deltas must sum to zero on the
    // bucket that moved, and never touch the other bucket. Both WIN their conditional
    // update (they are genuinely opposite transitions), so both apply a delta.
    armExcludeRow({ recommended: true, exclude: false }, { won: true });
    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    armExcludeRow({ recommended: true, exclude: true }, { won: true });
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
  it('hiding an ALREADY-hidden review writes no counter and busts no cache', async () => {
    armExcludeRow({ recommended: true, exclude: true }, { won: false });

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(res).toEqual({ id: REVIEW_ID, appListingId: APP_ID, exclude: true, changed: false });
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('un-hiding an already-VISIBLE review writes no counter and busts no cache', async () => {
    armExcludeRow({ recommended: false, exclude: false }, { won: false });

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: false });

    expect(res).toMatchObject({ exclude: false, changed: false });
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('hiding TWICE moves the counter exactly ONCE (a SEQUENTIAL retry cannot double-count)', async () => {
    armExcludeRow({ recommended: true, exclude: false }, { won: true });
    const first = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    // Second call: the row is already hidden, so its conditional update matches nothing.
    armExcludeRow({ recommended: true, exclude: true }, { won: false });
    const second = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(mockWrite.appListingMetric.upsert).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// CONCURRENCY — the case the sequential retry above CANNOT see.
//
// 🔴 `$transaction` here is Postgres READ COMMITTED (nothing in src/server sets an
// `isolationLevel`), which does not serialize a read against a concurrent committer.
// Under a read-then-branch guard, two moderators hiding the same review both read
// `exclude=false`, both pass the guard, and both apply −1 — permanent drift, masked
// by the ≥0 clamp only at zero. The sequential test above models the SECOND call
// seeing the FIRST's committed result, which is exactly the interleaving that does
// not happen in the race, so it is structurally blind to this.
//
// The fix is that the transition is the UPDATE's own predicate: the loser gets
// `count === 0` and must apply NOTHING. These tests drive that branch directly.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — losing a concurrent race applies ZERO delta', () => {
  it('LOSER: the row read back is already hidden but our conditional matched 0 rows → no delta', async () => {
    // The pre-state was `exclude:false` — a read-then-branch guard would have seen
    // that and applied −1. We lost the race, so the counter must not move.
    armExcludeRow({ recommended: true, exclude: false }, { won: false, observedAfter: true });

    const res = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(res.changed).toBe(false);
    // Reports the OBSERVED state, not the requested target — the winner's write stands.
    expect(res.exclude).toBe(true);
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.updateMany).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('two racing hides of the same review move the counter exactly ONCE in total', async () => {
    // Both callers start from `exclude:false`. Exactly one conditional update matches.
    armExcludeRow({ recommended: true, exclude: false }, { won: true });
    const winner = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });
    armExcludeRow({ recommended: true, exclude: false }, { won: false, observedAfter: true });
    const loser = await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect([winner.changed, loser.changed]).toEqual([true, false]);
    // ONE −1, not two. This is the assertion the whole conditional-update shape exists for.
    const increments = mockWrite.appListingMetric.upsert.mock.calls.map(
      (c) => (c[0] as { update: { thumbsUpCount?: { increment: number } } }).update.thumbsUpCount
    );
    expect(increments).toEqual([{ increment: -1 }]);
  });

  it('reads `recommended` AFTER taking the row lock, so a racing edit cannot misdirect the delta', async () => {
    armExcludeRow({ recommended: true, exclude: false }, { won: true });

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    // ORDER IS THE GUARD: the conditional update takes the row lock, and only then is
    // `recommended` read. Reading first would let a concurrent author flip land between
    // the two and send the −1 to the wrong bucket. Pinned so a "tidy-up" that hoists the
    // read back above the update fails here rather than in production.
    const updateOrder = mockWrite.appListingReview.updateMany.mock.invocationCallOrder[0];
    const readOrder = mockWrite.appListingReview.findUnique.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(readOrder);
  });
});

// ---------------------------------------------------------------------------
// Atomicity + not-found.
// ---------------------------------------------------------------------------
describe('setAppListingReviewExclude — transaction + lookup', () => {
  it('makes EVERY write through the transaction client, never the plain dbWrite', async () => {
    armExcludeRow({ recommended: true, exclude: false }, { won: true });

    await setAppListingReviewExclude({ reviewId: REVIEW_ID, exclude: true });

    expect(dbMock.dbWrite.$transaction).toHaveBeenCalledTimes(1);
    // 🔴 THIS is what makes the name of the test true. `$transaction` was called is a
    // claim about one line; that the flag flip and the counter move BOTH landed on the
    // sentinel `tx` handle — and that the non-transactional client saw NOTHING — is the
    // claim that a change moving either write outside the tx would break.
    expect(mockWrite.appListingReview.updateMany).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingMetric.upsert).toHaveBeenCalledTimes(1);
    for (const spy of outOfTxWrites) expect(spy).not.toHaveBeenCalled();
    // And the delta-deciding read must NOT come off the replica — a lagging read would
    // recompute a delta that was already applied.
    expect(mockRead.appListingReview.findUnique).not.toHaveBeenCalled();
    expect(mockRead.appListingReview.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListingReview.findUnique).toHaveBeenCalledWith({
      where: { id: REVIEW_ID },
      select: { id: true, appListingId: true, recommended: true, exclude: true },
    });
  });

  it('a missing review → NOT_FOUND, with no counter write', async () => {
    txMock.appListingReview.updateMany.mockResolvedValue({ count: 0 });
    txMock.appListingReview.findUnique.mockResolvedValue(null);

    await expect(
      setAppListingReviewExclude({ reviewId: 12345, exclude: true })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockBust).not.toHaveBeenCalled();
  });

  it('a real transition busts the store-wide recommend-mean cache', async () => {
    armExcludeRow({ recommended: true, exclude: false }, { won: true });
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
    // The prior review is read with `SELECT … FOR UPDATE` (raw, because Prisma has no
    // row lock on `findUnique`), so it arrives as an array of rows.
    txMock.$queryRaw.mockResolvedValue([{ id: REVIEW_ID, recommended: true, exclude: true }]);
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

// ---------------------------------------------------------------------------
// WRITER-SET LEDGER — the seam the whole delta design rests on.
//
// 🔴 `thumbsUpCount`/`thumbsDownCount` have NO recompute: the stored value is the
// sum of the ±1 deltas its writers applied, so a THIRD writer that does not share
// this file's `countedContribution` rule silently desynchronises the counter from
// the rows, and no test above would notice — every one of them verifies a single
// writer in isolation.
//
// The prose said "a future job MUST NOT become a third" and nothing enforced it.
// This does, and it fails in BOTH directions: the assertion is an EQUALITY against
// the ledger, so removing a writer (a refactor that quietly stops feeding the
// metric) is as red as adding one.
//
// This is one half of a TWO-SIDED contract. The other half — that the metric
// processor `src/server/metrics/appListing.metrics.sql.ts` never names the thumbs
// columns — is pinned in `src/server/metrics/__tests__/appListing.metrics.test.ts`
// ("NEVER writes thumbs_up_count / thumbs_down_count"). Neither guard alone is
// enough; each names the other so the pair stays discoverable.
// ---------------------------------------------------------------------------
describe('writer-set ledger — who may move the recommend counters', () => {
  const SERVICE_REL = 'src/server/services/blocks/app-listing-review.service.ts';

  /** The ONLY functions permitted to apply a recommend-counter delta. */
  const LEDGER = ['setAppListingReviewExclude', 'upsertAppListingReview'];

  /**
   * 🔴 Strip comments before scanning. Both files in `src/server/metrics/` DESCRIBE
   * the thumbs columns in a prose ownership note — and a scanner that reads prose as
   * code flags the very file whose comment promises it does not write them. Measured:
   * without this, the repo-wide scan below returned 3 files, 2 of them comment-only
   * false positives. A guard that cries wolf on its own documentation gets deleted.
   */
  function stripComments(src: string) {
    return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  }

  const REPO_ROOT = path.resolve(__dirname, '../../../../..');

  function readRel(rel: string) {
    return readFileSync(path.join(REPO_ROOT, rel), 'utf8');
  }

  function serviceSource() {
    return stripComments(readRel(SERVICE_REL));
  }

  /**
   * Does this (comment-stripped) source WRITE the recommend counters?
   *
   * 🔴 `\bUPDATE\s`, not `UPDATE`. The bare form matches the `update` inside
   * `updated_at`, which appears in every metrics SELECT — so the first version of
   * this flagged `app-listing.service.ts`, a file that only READS the rollup. A
   * scanner whose verdict is "everyone is a writer" is the same as one whose verdict
   * is "nobody is": neither carries information. Controlled both ways below.
   */
  function writesThumbs(src: string) {
    const prismaWrite = /appListingMetric\.(upsert|update|updateMany|create|createMany)\s*\(/.test(
      src
    );
    const rawWrite =
      /(\bINSERT\s+INTO\b|\bUPDATE\s)[\s\S]{0,400}?(thumbs_up_count|thumbs_down_count)/i.test(src);
    return prismaWrite || rawWrite;
  }

  /**
   * Every CALL of `applyRecommendMetricDelta`, attributed to the nearest preceding
   * `function <name>` — which is the enclosing top-level function, because the
   * callbacks in between are anonymous arrows.
   */
  function deltaCallers(src: string) {
    const lines = src.split('\n');
    const callers: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      // A call, not the declaration itself and not a mention inside a comment.
      if (!/(?<![\w.])applyRecommendMetricDelta\s*\(/.test(lines[i])) continue;
      if (/^\s*(\*|\/\/)/.test(lines[i])) continue;
      if (/function\s+applyRecommendMetricDelta/.test(lines[i])) continue;
      for (let j = i; j >= 0; j--) {
        const m = /function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[j]);
        if (m && m[1] !== 'applyRecommendMetricDelta') {
          callers.push(m[1]);
          break;
        }
      }
    }
    return callers;
  }

  it('POSITIVE CONTROL: the scan finds the service, its call sites, and its real writes', () => {
    // Without this, a broken path or a renamed helper makes every claim below
    // vacuously true — an empty set trivially equals an empty set.
    const src = serviceSource();
    expect(src).toContain('applyRecommendMetricDelta');
    expect(deltaCallers(src).length).toBeGreaterThan(0);
    // NEGATIVE CONTROL on the comment stripper: it must remove PROSE without eating
    // the CODE the repo-wide scan below is looking for. If this line ever fails, the
    // scan's "no other writers" verdict is worthless — it would be finding nothing
    // anywhere, including here.
    expect(src).toContain('appListingMetric.upsert(');
    expect(stripComments('// appListingMetric.upsert( in a comment\nconst a = 1;')).not.toContain(
      'appListingMetric'
    );
  });

  it('CONTROLS: the writer predicate goes red on a real write and stays quiet on a read', () => {
    // NEGATIVE CONTROL — it MUST detect each shape a third writer could take.
    expect(writesThumbs('await tx.appListingMetric.upsert({ where: {} })')).toBe(true);
    expect(writesThumbs('await db.appListingMetric.updateMany({ where: {} })')).toBe(true);
    expect(
      writesThumbs('UPDATE "app_listing_metrics" SET "thumbs_up_count" = 5 WHERE id = $1')
    ).toBe(true);
    expect(writesThumbs('INSERT INTO "app_listing_metrics" ("thumbs_down_count") VALUES (1)')).toBe(
      true
    );

    // POSITIVE CONTROL that it is not simply always-true — a pure READ of the same
    // columns is not a write, and neither is the `updated_at` that appears beside them
    // in every metrics SELECT (the exact false positive this predicate had at first).
    expect(
      writesThumbs('SELECT m."thumbs_up_count", m."updated_at" FROM app_listing_metrics m')
    ).toBe(false);
    expect(writesThumbs('const n = metric.thumbsUpCount ?? 0;')).toBe(false);
  });

  it('the delta writer has EXACTLY the ledgered callers — fails if the set grows OR shrinks', () => {
    const callers = [...new Set(deltaCallers(serviceSource()))].sort();
    expect(
      callers,
      'A third writer of thumbsUp/DownCount desynchronises a counter nothing recomputes. ' +
        'Add one only together with a full recompute — and update this ledger deliberately.'
    ).toEqual(LEDGER);
  });

  it('no OTHER module writes the thumbs counters on appListingMetric', () => {
    // The counters are addressed as `appListingMetric.<method>` through Prisma, or as
    // the raw `thumbs_up_count` / `thumbs_down_count` columns in SQL. The metric
    // processor legitimately touches the TABLE (install_count) and is held to the
    // thumbs half of the contract by its OWN guard, so this scan targets the thumbs
    // columns and the Prisma model — not the table name.
    const files = globSync('src/server/**/*.ts', { cwd: REPO_ROOT }).filter(
      (f: string) => !f.includes('__tests__')
    );
    // POSITIVE CONTROL on the walk itself.
    expect(files.length).toBeGreaterThan(200);

    const writers = files.filter((rel: string) => writesThumbs(stripComments(readRel(rel))));

    expect(
      writers.map((f: string) => f.replace(/\\/g, '/')).sort(),
      'Only the review service may write the recommend counters — see the two-sided ' +
        'contract at the top of app-listing-review.service.ts.'
    ).toEqual([SERVICE_REL]);
  });
});
