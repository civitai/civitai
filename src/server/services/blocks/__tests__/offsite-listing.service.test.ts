import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  MAX_PENDING_OFFSITE_SUBMISSIONS,
  OffsiteRequestError,
  approveExternalRequest,
  persistListingAssetImage,
  rejectExternalRequest,
  submitExternalListing,
  withdrawExternalRequest,
} from '~/server/services/blocks/offsite-listing.service';
import type {
  PersistListingAssetImageInput,
  SubmitExternalListingInput,
} from '~/server/schema/blocks/offsite-listing.schema';

/**
 * App Store Listings (W13 P3a) — off-site submission SERVICE tests (design B1).
 *
 * Covers submit (draft AppListing + pending request in one tx; owner-binding;
 * slug-collision pre-check AND P2002-race branch; cross-kind block-id collision;
 * URL re-validation; unknown category), withdraw (own-pending → withdrawn + draft
 * deletion; NOT_OWNED / NOT_PENDING / idempotent-withdrawn; the status-guarded
 * TOCTOU re-read), approve (mandatory-asset gate re-asserted on the PRIMARY inside
 * the tx; TOCTOU; self-approve) and reject (atomic flip+delete in one tx). All DB
 * deps are mocked — no real Prisma.
 *
 * REPLICA vs PRIMARY: `dbRead` and `dbWrite` are DISTINCT mocks (`mockRead` /
 * `mockWrite`) so a test can prove which client a read went through — notably that
 * the approve asset gate re-reads the PRIMARY (`mockWrite`/`tx`), not the replica
 * (`mockRead`), so it can't pass on stale-complete replica state under lag.
 */

type Client = {
  appListing: {
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  appListingScreenshot: {
    count: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  image: { findMany: ReturnType<typeof vi.fn> };
  appBlock: { findFirst: ReturnType<typeof vi.fn> };
  appListingPublishRequest: {
    findUnique: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
};

// `persistListingAssetImage` dynamically imports `createImage` from the image
// service. Mock it so the scan-invariant test can assert HOW it is called (owner +
// no `skipIngestion`) without pulling the heavy image.service graph.
const { mockCreateImage } = vi.hoisted(() => ({
  mockCreateImage: vi.fn(async (..._a: unknown[]) => ({ id: 12345 })),
}));

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const makeClient = () => ({
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (args: { data: unknown }) => args.data),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListingScreenshot: {
      count: vi.fn(async (..._a: unknown[]) => 0),
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
    },
    image: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
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
  });
  const mockRead = makeClient();
  // The PRIMARY client also owns `$transaction`; the interactive tx runs the
  // callback with `mockWrite` itself as `tx` (so tx-scoped reads/writes hit the
  // primary mock, exactly like a real interactive transaction).
  const mockWrite = makeClient() as ReturnType<typeof makeClient> & {
    $transaction: ReturnType<typeof vi.fn>;
  };
  mockWrite.$transaction = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  return { mockRead, mockWrite, ids: { n: 0 } };
});

const { mockNotify } = vi.hoisted(() => ({ mockNotify: vi.fn(async () => undefined) }));

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/image.service', () => ({ createImage: mockCreateImage }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingId: () => `apl_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
}));
// approve/reject emit an owner notification post-commit; assert it without pulling
// the notifications client graph.
vi.mock('~/server/services/blocks/app-listing-notify', () => ({ notifyAppListingOwner: mockNotify }));

const CALLER = 42;
const OTHER = 99;

const validInput: SubmitExternalListingInput = {
  slug: 'cool-app',
  name: 'Cool App',
  externalUrl: 'https://cool.example.com/app',
  contentRating: 'g',
};

function resetClient(c: Client) {
  c.appListing.findUnique.mockReset().mockResolvedValue(null);
  c.appListing.create.mockReset().mockImplementation(async (a: { data: unknown }) => a.data);
  c.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
  c.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  c.appListingScreenshot.count.mockReset().mockResolvedValue(0);
  c.appListingScreenshot.findMany.mockReset().mockResolvedValue([]);
  c.image.findMany.mockReset().mockResolvedValue([]);
  c.appBlock.findFirst.mockReset().mockResolvedValue(null);
  c.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
  c.appListingPublishRequest.count.mockReset().mockResolvedValue(0);
  c.appListingPublishRequest.create
    .mockReset()
    .mockImplementation(async (a: { data: unknown }) => a.data);
  c.appListingPublishRequest.updateMany.mockReset().mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  ids.n = 0;
  resetClient(mockRead as unknown as Client);
  resetClient(mockWrite as unknown as Client);
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(mockWrite));
  mockCreateImage.mockReset().mockResolvedValue({ id: 12345 });
  mockNotify.mockReset().mockResolvedValue(undefined);
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

    // Rows are created on the PRIMARY (inside the tx).
    const listingData = mockWrite.appListing.create.mock.calls[0][0].data as Record<string, unknown>;
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

    const reqData = mockWrite.appListingPublishRequest.create.mock.calls[0][0]
      .data as Record<string, unknown>;
    expect(reqData).toMatchObject({
      kind: 'offsite',
      status: 'pending',
      slug: 'cool-app',
      appListingId: res.listingId,
      submittedByUserId: CALLER,
    });
    // Both writes happened inside the transaction on the primary.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
  });

  it('IDOR: the created rows always carry the AUTHENTICATED caller as owner/submitter', async () => {
    // Even if the input somehow carried a foreign userId-like field, the service
    // reads only `userId` (the authenticated caller) — there is no owner input.
    await submitExternalListing({ input: validInput, userId: OTHER });
    const listingData = mockWrite.appListing.create.mock.calls[0][0].data as { userId: number };
    const reqData = mockWrite.appListingPublishRequest.create.mock.calls[0][0]
      .data as { submittedByUserId: number };
    expect(listingData.userId).toBe(OTHER);
    expect(reqData.submittedByUserId).toBe(OTHER);
  });

  it('slug already taken (existing AppListing pre-check on the replica) → friendly BAD_REQUEST, no write', async () => {
    mockRead.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('slug taken via the P2002 create RACE → same friendly error', async () => {
    // Pre-checks pass (null), but the unique constraint fires inside the tx.
    mockWrite.$transaction.mockRejectedValue({ code: 'P2002' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
  });

  it('a non-P2002 tx error is NOT masked as a slug collision', async () => {
    mockWrite.$transaction.mockRejectedValue(new Error('db down'));
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toThrow(
      'db down'
    );
  });

  it('cross-kind: a slug equal to an existing AppBlock.block_id (replica pre-check) is rejected', async () => {
    mockRead.appBlock.findFirst.mockResolvedValue({ id: 'block_x' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('cross-kind: block_id collision missed by the replica pre-check is caught by the PRIMARY re-check inside the tx (no draft created)', async () => {
    // Replica pre-check (mockRead) is lag-stale → null; the PRIMARY re-read inside
    // the tx (mockWrite) sees the block → same friendly error, and the draft
    // AppListing is never created.
    mockRead.appBlock.findFirst.mockResolvedValue(null);
    mockWrite.appBlock.findFirst.mockResolvedValue({ id: 'block_lagged' });
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'BAD_REQUEST', message: expect.stringContaining('already taken') }
    );
    // The tx opened (primary re-check runs inside it) but no rows were created.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListing.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
  });

  it('per-user pending cap: AT the cap → TOO_MANY_REQUESTS, no write', async () => {
    mockRead.appListingPublishRequest.count.mockResolvedValue(MAX_PENDING_OFFSITE_SUBMISSIONS);
    await expect(submitExternalListing({ input: validInput, userId: CALLER })).rejects.toMatchObject(
      { code: 'TOO_MANY_REQUESTS', message: expect.stringContaining('pending') }
    );
    // The count is scoped to the caller's pending offsite requests (on the replica).
    expect(mockRead.appListingPublishRequest.count).toHaveBeenCalledWith({
      where: { submittedByUserId: CALLER, kind: 'offsite', status: 'pending' },
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('per-user pending cap: UNDER the cap → allowed (draft created)', async () => {
    mockRead.appListingPublishRequest.count.mockResolvedValue(MAX_PENDING_OFFSITE_SUBMISSIONS - 1);
    const res = await submitExternalListing({ input: validInput, userId: CALLER });
    expect(res.slug).toBe('cool-app');
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
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
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('re-validates externalUrl (a non-https URL is rejected before any write)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, externalUrl: 'http://insecure.example.com' },
        userId: CALLER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an unknown category (service re-checks the taxonomy)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, category: 'bogus' as never },
        userId: CALLER,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('category') });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a submission declaring an on-platform surface (defense-in-depth)', async () => {
    await expect(
      submitExternalListing({
        input: { ...validInput, iframe: { src: 'https://x.civit.ai' } } as never,
        userId: CALLER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withdrawExternalRequest
// ---------------------------------------------------------------------------

describe('withdrawExternalRequest', () => {
  it('own pending → withdrawn + the draft listing is deleted (slug released)', async () => {
    // Classify read is on the replica; the guarded flip + delete are on the primary.
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER });

    expect(mockWrite.appListingPublishRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'alpr_1', status: 'pending' },
      data: { status: 'withdrawn' },
    });
    // Draft deletion is status-guarded (never removes an approved listing).
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: 'draft' },
    });
  });

  it('NOT_OWNED when the request belongs to another user (no write)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: OTHER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      withdrawExternalRequest({ publishRequestId: 'nope', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('NOT_PENDING when the request is already approved (no write)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('idempotent: an already-withdrawn request is a no-op success (no delete)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'withdrawn',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).resolves.toBeUndefined();
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('TOCTOU: guarded write matches 0 rows, PRIMARY re-read shows withdrawn → idempotent success', async () => {
    // Classify (replica) = pending; the guarded flip (primary) matches 0; the
    // re-read is done on the PRIMARY (mockWrite) and shows withdrawn.
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    mockWrite.appListingPublishRequest.findUnique.mockResolvedValue({ status: 'withdrawn' });

    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).resolves.toBeUndefined();
    // We did not perform the withdraw → we do NOT re-delete the draft.
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('TOCTOU: guarded write matches 0 rows, PRIMARY re-read shows approved → NOT_PENDING', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      submittedByUserId: CALLER,
      appListingId: 'apl_1',
    });
    mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    mockWrite.appListingPublishRequest.findUnique.mockResolvedValue({ status: 'approved' });

    await expect(
      withdrawExternalRequest({ publishRequestId: 'alpr_1', userId: CALLER })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('the thrown error is an OffsiteRequestError with a typed code', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
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

/**
 * Stage a pending offsite request + a draft listing with the given asset state.
 * Sets the state on BOTH the replica (mockRead — the pre-tx fail-fast reads) and
 * the primary (mockWrite — the authoritative in-tx gate reads) so a normal
 * (non-lagged) scenario passes both. A replica-vs-primary DIVERGENCE test overrides
 * one client afterwards.
 */
function stageApproveScenario(listing: {
  iconId?: number | null;
  coverId?: number | null;
  screenshotCount?: number;
  externalUrl?: string;
  status?: string;
  submittedByUserId?: number;
}) {
  mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
    id: 'alpr_1',
    status: 'pending',
    kind: 'offsite',
    slug: 'cool-app',
    appListingId: 'apl_1',
    submittedByUserId: listing.submittedByUserId ?? CALLER,
  });
  const listingRow = {
    id: 'apl_1',
    status: listing.status ?? 'draft',
    externalUrl: listing.externalUrl ?? 'https://cool.example.com/app',
    iconId: listing.iconId === undefined ? 1 : listing.iconId,
    coverId: listing.coverId === undefined ? 2 : listing.coverId,
    // Owner fields the approve path reads for the post-commit owner notification.
    userId: listing.submittedByUserId ?? CALLER,
    name: 'Cool App',
    slug: 'cool-app',
    revisionOfId: null,
  };
  const count = listing.screenshotCount === undefined ? 1 : listing.screenshotCount;
  mockRead.appListing.findUnique.mockResolvedValue(listingRow);
  mockRead.appListingScreenshot.count.mockResolvedValue(count);
  mockWrite.appListing.findUnique.mockResolvedValue(listingRow);
  mockWrite.appListingScreenshot.count.mockResolvedValue(count);
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

    // Request flip (status-guarded) is the FIRST updateMany call on the primary.
    const reqCall = mockWrite.appListingPublishRequest.updateMany.mock.calls[0][0] as {
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

    // Listing flip (status-guarded so an approved listing is never re-flipped). The
    // guard now accepts draft OR pending (the W13 reset-to-pending reopen path). The
    // derived content rating is stamped alongside the status; with no asset levels
    // staged the derive fails safe to 'g'.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: { in: ['draft', 'pending'] } },
      data: { status: 'approved', contentRating: 'g' },
    });
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);

    // Post-commit: the OWNER is notified their app went live.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app-listing-approved',
        userId: CALLER,
        details: expect.objectContaining({ slug: 'cool-app', listingId: 'apl_1' }),
      })
    );
  });

  it('W13 REOPEN round-trip: a reset-to-pending listing (status pending) re-approves via the widened {draft,pending} guard', async () => {
    // After resetListingToPending the listing is `pending` with a fresh pending
    // request. Re-approving must succeed — proving the widened guard accepts pending.
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1, status: 'pending' });
    const res = await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    expect(res).toEqual({ publishRequestId: 'alpr_1', listingId: 'apl_1', slug: 'cool-app' });
    // The listing flip fired with the widened guard (pending row matched → approved).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: { in: ['draft', 'pending'] } },
      data: { status: 'approved', contentRating: 'g' },
    });
    // Owner re-notified their app is live again.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-listing-approved', userId: CALLER })
    );
  });

  it('the AUTHORITATIVE asset gate reads the PRIMARY (tx), not the replica', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    // The gate's icon/cover read + the imageId-bearing screenshot count both go
    // through the PRIMARY client (`tx` === mockWrite) inside the transaction.
    expect(mockWrite.appListing.findUnique).toHaveBeenCalledWith({
      where: { id: 'apl_1' },
      select: { externalUrl: true, iconId: true, coverId: true },
    });
    expect(mockWrite.appListingScreenshot.count).toHaveBeenCalledWith({
      where: { appListingId: 'apl_1', imageId: { not: null } },
    });
  });

  it('REPLICA-LAG: replica reports COMPLETE but the PRIMARY is INCOMPLETE → approve BLOCKED (no flip)', async () => {
    // The pre-tx fail-fast reads the (lag-stale) replica, which still shows a cover
    // — so it passes. The AUTHORITATIVE in-tx gate reads the primary, where a
    // concurrent owner edit removed the cover → the gate must FAIL and roll back.
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    mockWrite.appListing.findUnique.mockResolvedValue({
      id: 'apl_1',
      status: 'draft',
      externalUrl: 'https://cool.example.com/app',
      iconId: 1,
      coverId: null, // primary: cover was concurrently removed
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cover') });
    // We DID open the tx (the authoritative gate runs inside it) but bailed BEFORE
    // any flip — neither the request nor the listing status changed.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('REPLICA-LAG: replica shows a screenshot but the PRIMARY count is 0 → approve BLOCKED', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    mockWrite.appListingScreenshot.count.mockResolvedValue(0); // primary: no real screenshot
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('screenshots'),
    });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('supersedes any SIBLING pending request for the same slug (parity with on-site)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    // The 2nd request updateMany is the supersede: same slug, pending, NOT this row.
    const supersede = mockWrite.appListingPublishRequest.updateMany.mock.calls[1][0] as {
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
    // Missing on the replica too → fail-fast before the tx even opens.
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('BLOCKED by assertListingAssetsComplete — missing COVER → BAD_REQUEST, no mutation', async () => {
    stageApproveScenario({ iconId: 1, coverId: null, screenshotCount: 1 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('cover') });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('BLOCKED by assertListingAssetsComplete — missing SCREENSHOT → BAD_REQUEST, no mutation', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('screenshots'),
    });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('all assets present → the gate PASSES (approve proceeds); the count query excludes imageId-null rows', async () => {
    stageApproveScenario({ iconId: 9, coverId: 8, screenshotCount: 3 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).resolves.toMatchObject({ listingId: 'apl_1' });
    // A screenshot whose Image was deleted (imageId null) is excluded by the count
    // query — assert we filter on imageId != null on the primary.
    expect(mockWrite.appListingScreenshot.count).toHaveBeenCalledWith({
      where: { appListingId: 'apl_1', imageId: { not: null } },
    });
  });

  it('rejects a NON-PENDING request (already approved) → NOT_PENDING, no listing load', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      kind: 'offsite',
      slug: 'cool-app',
      appListingId: 'apl_1',
    });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue(null);
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
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('TOCTOU: the guarded request flip matches 0 rows (concurrent withdraw) → NOT_PENDING, listing NOT flipped', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    // Inside the tx, the request updateMany loses the race → count 0.
    mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    // The tx opened + the request flip ran, but we bailed BEFORE the listing flip.
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('mod SELF-APPROVE is ALLOWED (v1): reviewer == submitter succeeds (no self-approve block)', async () => {
    // The request was submitted by the SAME mod who now approves it. The service
    // does not compare reviewer to submitter, so this is allowed by design.
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1, submittedByUserId: MOD });
    await expect(
      approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD })
    ).resolves.toMatchObject({ publishRequestId: 'alpr_1', listingId: 'apl_1' });
  });

  // -------------------------------------------------------------------------
  // Content-rating derive + mod override (floored). The author is never blocked on
  // the scanner's rating; the authoritative rating is DERIVED from the assets' max
  // detected nsfwLevel at approve, with an optional mod override that is FLOORED at
  // the derived value (never publishes mature assets under a too-low rating).
  // -------------------------------------------------------------------------

  /** Stage the PRIMARY (tx) asset-level reads used by resolveApprovalContentRating. */
  function stagePrimaryAssetLevels(levels: { id: number; nsfwLevel: number }[]) {
    // The screenshot ids the derive gathers (icon/cover come from the listing row).
    mockWrite.appListingScreenshot.findMany.mockResolvedValue(
      levels.filter((l) => l.id >= 10).map((l) => ({ imageId: l.id }))
    );
    mockWrite.image.findMany.mockResolvedValue(levels.map((l) => ({ nsfwLevel: l.nsfwLevel })));
  }

  function ratingStampedOnFlip(): unknown {
    // The status flip is the updateMany that stamps `contentRating` (the widened
    // reopen guard is `where.status = { in: ['draft','pending'] }`, no longer a
    // plain 'draft' string — match on the data shape instead).
    const flip = mockWrite.appListing.updateMany.mock.calls.find(
      (c) => (c[0] as { data?: { contentRating?: unknown } }).data?.contentRating !== undefined
    );
    return (flip?.[0] as { data: { contentRating?: unknown } }).data.contentRating;
  }

  it('DERIVES the rating from the assets max nsfwLevel (icon PG, cover PG13, screenshot R → r)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    stagePrimaryAssetLevels([
      { id: 1, nsfwLevel: 1 }, // icon PG
      { id: 2, nsfwLevel: 2 }, // cover PG13
      { id: 10, nsfwLevel: 4 }, // screenshot R
    ]);
    await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    expect(ratingStampedOnFlip()).toBe('r');
  });

  it('a mod override ABOVE the derived rating is HONOURED (derived r, override x → x)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    stagePrimaryAssetLevels([
      { id: 1, nsfwLevel: 1 },
      { id: 2, nsfwLevel: 2 },
      { id: 10, nsfwLevel: 4 }, // derived r
    ]);
    await approveExternalRequest({
      publishRequestId: 'alpr_1',
      reviewerUserId: MOD,
      contentRating: 'x',
    });
    expect(ratingStampedOnFlip()).toBe('x');
  });

  it('🔴 an UNDER-rating override is FLOORED to the derived value (derived r, override g → r)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    stagePrimaryAssetLevels([
      { id: 1, nsfwLevel: 1 },
      { id: 2, nsfwLevel: 2 },
      { id: 10, nsfwLevel: 4 }, // derived r
    ]);
    await approveExternalRequest({
      publishRequestId: 'alpr_1',
      reviewerUserId: MOD,
      contentRating: 'g', // BELOW derived → must NOT publish mature assets as 'g'
    });
    // Floored UP to the derived rating — never silently under-rated.
    expect(ratingStampedOnFlip()).toBe('r');
  });

  it('with no override, the DERIVED rating is stamped (all-PG assets → g)', async () => {
    stageApproveScenario({ iconId: 1, coverId: 2, screenshotCount: 1 });
    stagePrimaryAssetLevels([
      { id: 1, nsfwLevel: 1 },
      { id: 2, nsfwLevel: 1 },
      { id: 10, nsfwLevel: 1 },
    ]);
    await approveExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD });
    expect(ratingStampedOnFlip()).toBe('g');
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
    expect(mockRead.appListingPublishRequest.findUnique).not.toHaveBeenCalled();
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('pending → rejected + reviewedBy*/rejectionReason set + draft listing DELETED, ATOMICALLY in one tx', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    await rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON });

    // The flip + delete run inside ONE transaction on the primary (tx client).
    expect(mockWrite.$transaction).toHaveBeenCalledTimes(1);
    const call = mockWrite.appListingPublishRequest.updateMany.mock.calls[0][0] as {
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
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', status: 'draft' },
    });
  });

  it('notifies the OWNER their first-time submission was NOT approved (carrying the reason)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    // The pre-tx listing read (for the notification target) returns a first-time draft.
    mockRead.appListing.findUnique.mockResolvedValue({
      userId: CALLER,
      name: 'Cool App',
      slug: 'cool-app',
      revisionOfId: null,
    });
    await rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app-listing-rejected',
        userId: CALLER,
        details: expect.objectContaining({ slug: 'cool-app', reason: REASON }),
      })
    );
  });

  it('does NOT notify on a REVISION reject (parent stays live)', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_shadow',
    });
    // The rejected listing is a shadow revision (revisionOfId set) → no owner notice.
    mockRead.appListing.findUnique.mockResolvedValue({
      userId: CALLER,
      name: 'Cool App',
      slug: 'cool-app',
      revisionOfId: 'apl_parent',
    });
    await rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON });
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a NON-PENDING request → NOT_PENDING, no write', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'approved',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    await expect(
      rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('NOT_FOUND when the request does not exist', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue(null);
    await expect(
      rejectExternalRequest({ publishRequestId: 'nope', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('TOCTOU: the guarded flip matches 0 rows (concurrent approve) → NOT_PENDING, draft NOT deleted', async () => {
    mockRead.appListingPublishRequest.findUnique.mockResolvedValue({
      id: 'alpr_1',
      status: 'pending',
      kind: 'offsite',
      appListingId: 'apl_1',
    });
    mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      rejectExternalRequest({ publishRequestId: 'alpr_1', reviewerUserId: MOD, rejectionReason: REASON })
    ).rejects.toMatchObject({ code: 'NOT_PENDING' });
    // Lost the flip → the tx rolls back and we never delete the draft.
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// persistListingAssetImage — SCAN-INVARIANT regression guard
// ---------------------------------------------------------------------------

/**
 * SECURITY INVARIANT (the exact property the pre-merge audit turned on): a listing
 * asset image is created OWNED BY THE CALLER and goes through the standard
 * ingestion/scan pipeline — it is NEVER created with `skipIngestion`. `skipIngestion`
 * would create the Image already-Scanned (PendingManualAssignment), letting an
 * author inject an UNSCANNED, publicly-rendered listing asset. A future edit that
 * adds `skipIngestion: true` here MUST fail this test.
 */
describe('persistListingAssetImage (scan invariant)', () => {
  const persistInput: PersistListingAssetImageInput = {
    url: '11111111-1111-4111-8111-111111111111',
    name: 'icon.png',
    width: 512,
    height: 512,
    mimeType: 'image/png',
    sizeBytes: 4096,
  };

  it('creates the image OWNED BY THE CALLER and WITHOUT skipIngestion (Pending → ingestImage)', async () => {
    const res = await persistListingAssetImage({ input: persistInput, userId: CALLER });
    expect(res).toEqual({ imageId: 12345 });

    expect(mockCreateImage).toHaveBeenCalledTimes(1);
    const arg = mockCreateImage.mock.calls[0][0] as Record<string, unknown>;
    // Owner is the AUTHENTICATED caller — never a value from input.
    expect(arg.userId).toBe(CALLER);
    // The scan-bypass flag must be absent/falsy so the standard ingestion runs.
    expect(arg.skipIngestion).toBeFalsy();
    expect('skipIngestion' in arg && arg.skipIngestion === true).toBe(false);
    // Sanity: the persisted row carries the byte size the P1 validator reads.
    expect(arg).toMatchObject({ url: persistInput.url, type: 'image', userId: CALLER });
    expect(arg.metadata).toEqual({ size: 4096 });
  });

  it('binds the owner to the caller even for a different user id', async () => {
    await persistListingAssetImage({ input: persistInput, userId: OTHER });
    const arg = mockCreateImage.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.userId).toBe(OTHER);
    expect(arg.skipIngestion).toBeFalsy();
  });
});
