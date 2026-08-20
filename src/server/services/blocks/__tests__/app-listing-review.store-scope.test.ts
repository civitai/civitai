import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getMyAppListingReview,
  listAppListingReviews,
  upsertAppListingReview,
} from '~/server/services/blocks/app-listing-review.service';

/**
 * W13 — the review WRITE path's STORE-SCOPE KIND GATE.
 *
 * The scope decides WHICH KINDS a caller may act on, and reviewability is a question
 * about a kind. `public-external` admits `offsite` only; `full` admits both. This is
 * the write-side twin of `listAppListingReviews`'s relation filter, and both go
 * through the ONE shared rule (`scopeAdmitsListingKind` / its DB-filter form) so they
 * cannot drift.
 *
 * 🔴 EVERY ASSERTION HERE IS DRIVEN BY THE RESOLVED SCOPE, never by a flag name.
 * Keying reviewability on a flag is exactly the defect being fixed — the external
 * cohort holds neither flag `isAppListingsEnabled` reads, so a flag-shaped assertion
 * would pass while the cohort stayed locked out.
 *
 * 🔴 KIND IS CHECKED BEFORE OWNERSHIP AND STATUS, and one test below pins that
 * ORDER rather than just the outcome: a listing the caller's scope hides must not be
 * distinguishable from one that does not exist. If kind were checked last, this proc
 * would answer "not yours" / "not approved" / "not found" differentially and become
 * an existence oracle over the onsite catalogue for the external-only cohort.
 *
 * All DB deps are mocked — no real Prisma.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListingReview: { findUnique: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn> };
  appListingMetric: { upsert: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReview: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
};

// Fixtures: pairwise distinct, non-default, and no value equal to a constant an
// assertion names (ids are not 0/1; the two listing ids share no prefix).
const CALLER = 11072787; // camer047army744 — the real external-only tester
const OWNER = 5502; // someone else, so the self-review gate never fires
const OFFSITE_ID = 'apl_offsite_kt4';
const ONSITE_ID = 'apl_onsite_zw9';

const SAVED_REVIEW = {
  id: 8801,
  appListingId: OFFSITE_ID,
  userId: CALLER,
  recommended: true,
  details: null,
  createdAt: new Date('2026-08-19T09:15:00Z'),
  updatedAt: new Date('2026-08-19T09:15:00Z'),
};

const { mockRead, mockWrite } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListingReview: { findUnique: vi.fn(), upsert: vi.fn() },
    appListingMetric: { upsert: vi.fn(), updateMany: vi.fn() },
  };
  const read: ReadMock = {
    appListing: { findUnique: vi.fn() },
    appListingReview: { findFirst: vi.fn(), findMany: vi.fn() },
  };
  return { mockRead: read, mockWrite: write };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/cache-helpers', () => ({ bustCacheTag: vi.fn(async () => undefined) }));

/** An APPROVED listing of the given kind, owned by someone other than the caller. */
function listingOfKind(id: string, kind: 'onsite' | 'offsite') {
  return { id, userId: OWNER, status: 'approved', kind };
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
  mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(OFFSITE_ID, 'offsite'));
  mockRead.appListingReview.findFirst.mockResolvedValue(null);
  mockRead.appListingReview.findMany.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// upsertAppListingReview — the kind gate.
// ---------------------------------------------------------------------------

describe('upsertAppListingReview — public-external scope', () => {
  it('CAN review an OFFSITE listing (the whole point — this is all their scope shows them)', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(OFFSITE_ID, 'offsite'));
    const res = await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: OFFSITE_ID, recommended: true },
      scope: 'public-external',
    });
    expect(res.isNewReview).toBe(true);
    expect(mockWrite.appListingReview.upsert).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingReview.upsert.mock.calls[0][0].create).toMatchObject({
      appListingId: OFFSITE_ID,
      userId: CALLER,
      recommended: true,
    });
  });

  it('CANNOT review an ONSITE listing — NOT_FOUND, and nothing is written', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(ONSITE_ID, 'onsite'));
    await expect(
      upsertAppListingReview({
        userId: CALLER,
        input: { appListingId: ONSITE_ID, recommended: true },
        scope: 'public-external',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // No review row, and — just as important — no metric movement.
    expect(mockWrite.appListingReview.upsert).not.toHaveBeenCalled();
    expect(mockWrite.appListingMetric.upsert).not.toHaveBeenCalled();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('refuses an ONSITE listing the caller OWNS with NOT_FOUND, not the owner error — the gate is not an existence oracle', async () => {
    // Same kind refusal, but the listing is the caller's OWN and NOT approved. A
    // gate ordered after the owner/status checks would leak both facts by answering
    // FORBIDDEN ("you own this") or BAD_REQUEST ("not available") instead.
    mockRead.appListing.findUnique.mockResolvedValue({
      id: ONSITE_ID,
      userId: CALLER,
      status: 'draft',
      kind: 'onsite',
    });
    await expect(
      upsertAppListingReview({
        userId: CALLER,
        input: { appListingId: ONSITE_ID, recommended: false },
        scope: 'public-external',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('upsertAppListingReview — full scope is unchanged', () => {
  it('CAN review an ONSITE listing', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(ONSITE_ID, 'onsite'));
    const res = await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: ONSITE_ID, recommended: true },
      scope: 'full',
    });
    expect(res.isNewReview).toBe(true);
    expect(mockWrite.appListingReview.upsert).toHaveBeenCalledTimes(1);
  });

  it('CAN review an OFFSITE listing', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(OFFSITE_ID, 'offsite'));
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: OFFSITE_ID, recommended: true },
      scope: 'full',
    });
    expect(mockWrite.appListingReview.upsert).toHaveBeenCalledTimes(1);
  });

  it('an omitted scope defaults to `full` — pre-existing callers keep working', async () => {
    mockRead.appListing.findUnique.mockResolvedValue(listingOfKind(ONSITE_ID, 'onsite'));
    await upsertAppListingReview({
      userId: CALLER,
      input: { appListingId: ONSITE_ID, recommended: true },
    });
    expect(mockWrite.appListingReview.upsert).toHaveBeenCalledTimes(1);
  });

  it('the kind gate does NOT swallow the ordinary gates — a self-review is still refused', async () => {
    // Positive control on the ordering: with a kind the scope ADMITS, the later
    // owner check must still fire. Without this, a gate that refused everything
    // would look identical to a correct one in the tests above.
    mockRead.appListing.findUnique.mockResolvedValue({
      id: OFFSITE_ID,
      userId: CALLER,
      status: 'approved',
      kind: 'offsite',
    });
    await expect(
      upsertAppListingReview({
        userId: CALLER,
        input: { appListingId: OFFSITE_ID, recommended: true },
        scope: 'public-external',
      })
      // 🔴 Asserted on the MESSAGE, not just the code. `throwAuthorizationError`
      // yields UNAUTHORIZED — the same code the store-dark gate uses — so a code-only
      // assertion would pass if the kind gate had swallowed this branch and refused
      // for its own reason instead. The message is what distinguishes them.
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      message: 'You cannot review your own app',
    });
  });
});

// ---------------------------------------------------------------------------
// getMyAppListingReview — the same kind gate, soft (null, not a throw).
// ---------------------------------------------------------------------------

describe('getMyAppListingReview — kind gate', () => {
  it('public-external ANDs the offsite relation filter onto the lookup', async () => {
    mockRead.appListingReview.findFirst.mockResolvedValue(null);
    await getMyAppListingReview(OFFSITE_ID, CALLER, { scope: 'public-external' });
    expect(mockRead.appListingReview.findFirst.mock.calls[0][0].where).toEqual({
      appListingId: OFFSITE_ID,
      userId: CALLER,
      appListing: { is: { kind: 'offsite' } },
    });
  });

  it('full scope applies NO kind restriction', async () => {
    await getMyAppListingReview(ONSITE_ID, CALLER, { scope: 'full' });
    expect(mockRead.appListingReview.findFirst.mock.calls[0][0].where).toEqual({
      appListingId: ONSITE_ID,
      userId: CALLER,
      appListing: { is: {} },
    });
  });

  it('a hidden-kind listing yields null, not a throw (soft read posture)', async () => {
    // The relation filter matches nothing → Prisma returns null → so does the proc.
    mockRead.appListingReview.findFirst.mockResolvedValue(null);
    await expect(
      getMyAppListingReview(ONSITE_ID, CALLER, { scope: 'public-external' })
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The read path's filter, restated here so write and read are pinned side by side.
// ---------------------------------------------------------------------------

describe('listAppListingReviews — the read filter the write path mirrors', () => {
  it('public-external requires the listing to be approved AND offsite', async () => {
    await listAppListingReviews({ appListingId: OFFSITE_ID }, { scope: 'public-external' });
    expect(mockRead.appListingReview.findMany.mock.calls[0][0].where.appListing).toEqual({
      is: { status: 'approved', kind: 'offsite' },
    });
  });

  it('full requires approved only — no kind restriction', async () => {
    await listAppListingReviews({ appListingId: ONSITE_ID }, { scope: 'full' });
    expect(mockRead.appListingReview.findMany.mock.calls[0][0].where.appListing).toEqual({
      is: { status: 'approved' },
    });
  });
});
