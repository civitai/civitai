import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  MAX_PENDING_OFFSITE_SUBMISSIONS,
  OffsiteRequestError,
  approveExternalRequest,
  rejectExternalRequest,
  submitExternalListing,
  withdrawExternalRequest,
} from '~/server/services/blocks/offsite-listing.service';
import type { SubmitExternalListingInput } from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13 P3a) — off-site submission SERVICE tests (design B1).
 *
 * Covers submit (draft AppListing + pending request in one tx; owner-binding;
 * slug-collision pre-check AND P2002-race branch; cross-kind block-id collision;
 * URL re-validation; unknown category) and withdraw (own-pending → withdrawn +
 * draft deletion; NOT_OWNED / NOT_PENDING / idempotent-withdrawn; the
 * status-guarded TOCTOU re-read). All DB deps are mocked — no real Prisma.
 */

const { mockDb, ids } = vi.hoisted(() => ({
  mockDb: {
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 0),
    },
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      count: vi.fn(async (..._a: unknown[]) => 0),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    // Interactive transaction: run the callback with the same mock as `tx`.
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb)),
  },
  ids: { n: 0 },
}));

vi.mock('~/server/db/client', () => ({ dbRead: mockDb, dbWrite: mockDb }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
}));

const CALLER = 42;
const OTHER = 99;

const validInput: SubmitExternalListingInput = {
  slug: 'cool-app',
  name: 'Cool App',
  externalUrl: 'https://cool.example.com/app',
  contentRating: 'g',
};

beforeEach(() => {
  ids.n = 0;
  mockDb.appListing.findUnique.mockReset().mockResolvedValue(null);
  mockDb.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
  mockDb.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockDb.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mockDb.appListingScreenshot.count.mockReset().mockResolvedValue(0);
  mockDb.appBlock.findFirst.mockReset().mockResolvedValue(null);
  mockDb.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
  mockDb.appListingPublishRequest.count.mockReset().mockResolvedValue(0);
  mockDb.appListingPublishRequest.create
    .mockReset()
    .mockImplementation(async (a: { data: unknown }) => a.data);
  mockDb.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockDb.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockDb));
});

// ---------------------------------------------------------------------------
// submitExternalListing
// ---------------------------------------------------------------------------

describe('submitExternalListing', () => {
  it('happy path: creates a DRAFT offsite AppListing + a pending publish request', async () => {
    const res = await submitExternalListing({ input: validInput, userId: CALLER });

    expect(res.slug).toBe('cool-app');
    expect(res.listingId).toMatch(/^apl_test_/);
    expect(res.publishRequestId).toMatch(/^alpr_test_/);

    const listingData = mockDb.appListing.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(listingData).toMatchObject({
      kind: 'offsite',
      status: 'draft',
      slug: 'cool-app',
      externalUrl: 'https://cool.example.com/app',
      connectClientId: null,
      appBlockId: null,
      contentRating: 'g',
      userId: CALLER,
    });

    const reqData = mockDb.appListingPublishRequest.create.mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(reqData).toMatchObject({
      kind: 'offsite',
      status: 'pending',
      slug: 'cool-app',
      appListingId: res.listingId,
      submittedByUserId: CALLER,
    });
    // Both writes happened inside the transaction.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it('IDOR: the created rows always carry the AUTHENTICATED caller as owner/submitter', async () => {
    // Even if the input somehow carried a foreign userId-like field, the service
    // reads only `userId` (the authenticated caller) — there is no owner input.
    await submitExternalListing({ input: validInput, userId: OTHER });
    const listingData = mockDb.appListing.create.mock.calls[0][0].data as { userId: number };
    const reqData = mockDb.appListingPublishRequest.create.mock.calls[0][0]
      .data as { submittedByUserId: number };
    expect(listingData.userId).toBe(OTHER);
    expect(reqData.submittedByUserId).toBe(OTHER);
  });

  it('slug already taken (existing AppListing pre-check) → friendly BAD_REQUEST, no write', async () => {
    mockDb.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('slug taken via the P2002 create RACE → same friendly error', async () => {
    // Pre-checks pass (null), but the unique constraint fires inside the tx.
    mockDb.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
  });

  it('a non-P2002 tx error is NOT masked as a slug collision', async () => {
    mockDb.$transaction.mockRejectedValue(new Error('db down'));
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toThrow(
      'db down'
    );
  });

  it('cross-kind: a slug equal to an existing AppBlock.block_id is rejected', async () => {
    mockDb.appBlock.findFirst.mockResolvedValue({ id: 'block_x' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('cross-kind: block_id collision missed by the replica pre-check is caught by the PRIMARY re-check inside the tx (no draft created)', async () => {
    // Replica pre-check (1st findFirst) is lag-stale → null; the PRIMARY re-read
    // inside the tx (2nd findFirst) sees the block → same friendly error, and the
    // draft AppListing is never created.
    mockDb.appBlock.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'block_lagged' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    // The tx opened (primary re-check runs inside it) but no rows were created.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.appListing.create).not.toHaveBeenCalled();
    expect(mockDb.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('per-user pending cap: AT the cap → TOO_MANY_REQUESTS, no write', async () => {
    mockDb.appListingPublishRequest.count.mockResolvedValue(MAX_PENDING_OFFSITE_SUBMISSIONS);
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'TOO_MANY_REQUESTS', message: expect.stringContaining('pending') }
    );
    // The count is scoped to the caller's pending offsite requests.
    expect(mockDb.appListingPublishRequest.count).toHaveBeenCalledWith({
      where: { submittedByUserId: CALLER, kind: 'offsite', status: 'pending' },
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('per-user pending cap: UNDER the cap → allowed (draft created)', async () => {
    mockDb.appListingPublishRequest.count.mockResolvedValue(MAX_PENDING_OFFSITE_SUBMISSIONS - 1);
    const res = await submitExternalListing({ input: validInput, userId: CALLER });
    expect(res.slug).toBe('cool-app');
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it('re-asserts contentRating against the offsite enum (an out-of-set value is rejected before any write)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, contentRating: 'xxx' as never },
        userId: CALLER,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('content rating'),
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('re-validates externalUrl (a non-https URL is rejected before any write)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, externalUrl: 'http://insecure.example.com' },
        userId: CALLER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown category (service re-checks the taxonomy)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, category: 'bogus' as never },
        userId: CALLER,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('category') });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a submission declaring an on-platform surface (defense-in-depth)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, iframe: { src: 'https://x.civit.ai' } } as never,
        userId: CALLER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withdrawExternalRequest
// ---------------------------------------------------------------------------

describe('withdrawExternalRequest', () => {
  it('own pending → withdrawn + the draft listing is deleted (slug released)', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER });

    expect(mockDb.appListingPublishRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'alpr_1', status: 'pending' },
      data: { status: 'withdrawn' },
    });
    // Draft deletion is status-guarded (never removes an approved listing).
    expect(mockDb.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: 'draft' },
    });
  });

  it('NOT_OWNED when the request belongs to another user (no write)', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: OTHER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
    expect(mockDb.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      withdrawExternalRequest({ publishRequestId: 'nope', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('NOT_PENDING when the request is already approved (no write)', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockDb.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('idempotent: an already-withdrawn request is a no-op success (no delete)', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'withdrawn',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).resolves.toBeUndefined();
    expect(mockDb.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('TOCTOU: guarded write matches 0 rows, re-read shows withdrawn → idempotent success', async () => {
    mockDb.appListingPublishRequest.findUnique
      // classify read: pending
      .mockResolvedValueOnce({
        id: 'alpr_1',
        status: 'pending',
        submittedByUserId: CALLER,
        appListingId: 'apl_1',
      })
      // re-read from primary after count 0: raced into withdrawn
      .mockResolvedValueOnce({ status: 'withdrawn' });
    mockDb.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).resolves.toBeUndefined();
    // We did not perform the withdraw → we do NOT re-delete the draft.
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('TOCTOU: guarded write matches 0 rows, re-read shows approved → NOT_PENDING', async () => {
    mockDb.appListingPublishRequest.findUnique
      .mockResolvedValueOnce({
        id: 'alpr_1',
        status: 'pending',
        submittedByUserId: CALLER,
        appListingId: 'apl_1',
      })
      .mockResolvedValueOnce({ status: 'approved' });
    mockDb.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('the thrown error is an OffsiteRequestError with a typed code', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: OTHER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toBeInstanceOf(OffsiteRequestError);
  });
});

// ---------------------------------------------------------------------------
// approveExternalRequest
// ---------------------------------------------------------------------------

const MOD = 7; // reviewer

/** Stage a pending offsite request + a draft listing with the given asset state. */
function stageApproveScenario(listing: {
  iconId?: number | null;
  coverId?: number | null;
  screenshotCount?: number;
  externalUrl?: string;
  status?: string;
}) {
  mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_1',
    status: 'pending',
    kind: 'offsite',
    slug: 'cool-app',
    appListingId: 'apl_1',
  });
  mockDb.appListing.findUnique.mockResolvedValue({
    id: 'apl_1',
    status: listing.status ?? 'draft',
    externalUrl: listing.externalUrl ?? 'https://cool.example.com/app',
    iconId: listing.iconId === undefined ? 1 : listing.iconId,
    coverId: listing.coverId === undefined ? 2 : listing.coverId,
  });
  mockDb.appListingScreenshot.count.mockResolvedValue(
    listing.screenshotCount === undefined ? 1 : listing.screenshotCount
  );
}

describe('approveExternalRequest', () => {
  it('happy path: pending + assets-complete → listing draft→approved + request approved w/ reviewedBy*/approvalNotes', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    const res = await approveExternalRequest({
      publishRequestId: 'alpr_1',
      reviewerUserId: MOD,
      approvalNotes: 'looks good',
    });
    expect(res).toEqual({ publishRequestId: 'alpr_1', listingId: 'apl_1', slug: 'cool-app' });

    // Request flip (status-guarded) is the FIRST updateMany call.
    const reqCall = mockDb.appListingPublishRequest.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(reqCall.where).toEqual({ id: 'alpr_1', status: 'pending' });
    expect(reqCall.data).toMatchObject({
      status: 'approved',
      reviewedByUserId: MOD,
      approvalNotes: 'looks good',
    });
    expect(reqCall.data.reviewedAt).toBeInstanceOf(Date);

    // Listing flip (status-guarded so an approved listing is never re-flipped).
    expect(mockDb.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: 'draft' },
      data: { status: 'approved' },
    });
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
  });

  it('supersedes any SIBLING pending request for the same slug (parity with on-site)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    // The 2nd request updateMany is the supersede: same slug, pending, NOT this row.
    const supersede = mockDb.appListingPublishRequest.updateMany.mock.calls[1][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(supersede.where).toMatchObject({
      slug: 'cool-app',
      status: 'pending',
      kind: 'offsite',
      NOT: { id: 'alpr_1' },
    });
    expect(supersede.data).toEqual({ status: 'withdrawn' });
  });

  it('BLOCKED by assertListingAssetsComplete — missing ICON → BAD_REQUEST, no mutation', async () => {
    stageApproveScenario({ iconId: null, coverId: 2, screenshotCount: 1 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('icon') });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('BLOCKED by assertListingAssetsComplete — missing COVER → BAD_REQUEST, no mutation', async () => {
    stageApproveScenario({ iconId: 1, coverId: null, screenshotCount: 1 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cover') });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('BLOCKED by assertListingAssetsComplete — missing SCREENSHOT → BAD_REQUEST, no mutation', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('screenshots'),
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('all assets present → the gate PASSES (approve proceeds)', async () => {
    stageApproveScenario({ iconId: 9, coverId: 8, screenshotCount: 3 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).resolves.toMatchObject({ listingId: 'apl_1' });
    // A screenshot whose Image was deleted (imageId null) is excluded by the count
    // query — assert we filter on imageId != null.
    expect(mockDb.appListingScreenshot.count).toHaveBeenCalledWith({
      where: { appListingId: 'apl_1', imageId: { not: null } },
    });
  });

  it('rejects a NON-PENDING request (already approved) → NOT_PENDING, no listing load', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_1',
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockDb.appListing.findUnique).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      approveExternalRequest({ publishRequestId: 'nope', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('re-validates the STORED externalUrl — a non-https stored value BLOCKS approve', async () => {
    stageApproveScenario({
      iconId: 1,
      coverId: 2,
      screenshotCount: 1,
      externalUrl: 'http://insecure.example.com',
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('externalUrl'),
    });
    expect(mockDb.$transaction).not.toHaveBeenCalled();
  });

  it('TOCTOU: the guarded request flip matches 0 rows (concurrent withdraw) → NOT_PENDING, listing NOT flipped', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    // Inside the tx, the request updateMany loses the race → count 0.
    mockDb.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    // The tx opened + the request flip ran, but we bailed BEFORE the listing flip.
    expect(mockDb.$transaction).toHaveBeenCalledTimes(1);
    expect(mockDb.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('mod SELF-APPROVE is ALLOWED (v1): reviewer == submitter succeeds (no self-approve block)', async () => {
    // The request was submitted by the SAME mod who now approves it. The service
    // does not compare reviewer to submitter, so this is allowed by design.
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_1',
      submittedByUserId: MOD, // == reviewerUserId below
    });
    mockDb.appListing.findUnique.mockResolvedValue({
      id: 'apl_1',
      status: 'draft',
      externalUrl: 'https://cool.example.com/app',
      iconId: 1,
      coverId: 2,
    });
    mockDb.appListingScreenshot.count.mockResolvedValue(1);
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).resolves.toMatchObject({ publishRequestId: 'alpr_1', listingId: 'apl_1' });
  });
});

// ---------------------------------------------------------------------------
// rejectExternalRequest
// ---------------------------------------------------------------------------

describe('rejectExternalRequest', () => {
  const REASON = 'not a real app, looks like spam';

  it('reason < 10 chars → BAD_REQUEST, no DB read/write', async () => {
    await expect(
      rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: 'too short' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('at least') });
    expect(mockDb.appListingPublishRequest.findUnique).not.toHaveBeenCalled();
    expect(mockDb.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('pending → rejected + reviewedBy*/rejectionReason set + draft listing DELETED', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    await rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON });

    const call = mockDb.appListingPublishRequest.updateMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'alpr_1', status: 'pending' });
    expect(call.data).toMatchObject({
      status: 'rejected',
      reviewedByUserId: MOD,
      rejectionReason: REASON,
    });
    expect(call.data.reviewedAt).toBeInstanceOf(Date);
    // The draft listing is deleted (status-guarded — never removes an approved one).
    expect(mockDb.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: 'draft' },
    });
  });

  it('a NON-PENDING request → NOT_PENDING, no write', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    await expect(
      rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockDb.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      rejectExternalRequest({ publishRequestId: 'nope', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('TOCTOU: the guarded flip matches 0 rows (concurrent approve) → NOT_PENDING, draft NOT deleted', async () => {
    mockDb.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    mockDb.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    // Lost the flip → we never delete the draft (the winner owns cleanup).
    expect(mockDb.appListing.deleteMany).not.toHaveBeenCalled();
  });
});
