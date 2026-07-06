import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OffsiteRequestError,
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
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
    },
    appListingPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
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
  mockDb.appListing.deleteMany.mockReset().mockResolvedValue({ count: 1 });
  mockDb.appBlock.findFirst.mockReset().mockResolvedValue(null);
  mockDb.appListingPublishRequest.findUnique.mockReset().mockResolvedValue(null);
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
