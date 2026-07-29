import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OffsiteModerationError,
  resetOnsiteListingToPending,
} from '~/server/services/blocks/offsite-moderation.service';

/**
 * W13 ONSITE reset-to-pending — service tests (the deferred onsite reset, now built).
 *
 * `resetOnsiteListingToPending` bounces an APPROVED on-site (hosted app-block) listing
 * back into the block review queue: in ONE tx it flips the listing approved → pending,
 * SUSPENDS the backing block (the real runtime stop), CLONES the latest approved
 * `AppBlockPublishRequest` into a fresh `pending` one (assets/version KEPT — no owner
 * resubmit) so it re-enters `listPendingRequests`, and writes a `reset-to-pending`
 * audit event; post-commit it notifies the owner. All DB deps are mocked (no real
 * Prisma); `dbWrite.$transaction` runs its callback against the same write mock.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListing: { updateMany: ReturnType<typeof vi.fn> };
  appBlock: { updateMany: ReturnType<typeof vi.fn> };
  appBlockPublishRequest: { create: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { create: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appBlockPublishRequest: { findFirst: ReturnType<typeof vi.fn> };
};

const { mockRead, mockWrite, mockNotify, ids } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListing: { updateMany: vi.fn(async () => ({ count: 1 })) },
    appBlock: { updateMany: vi.fn(async () => ({ count: 1 })) },
    appBlockPublishRequest: { create: vi.fn(async (a: { data: unknown }) => a.data) },
    appListingModerationEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
  };
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appBlockPublishRequest: { findFirst: vi.fn(async () => null) },
  };
  return {
    mockRead: read,
    mockWrite: write,
    mockNotify: vi.fn(async () => undefined),
    ids: { n: 0 },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/services/blocks/app-listing-notify', () => ({ notifyAppListingOwner: mockNotify }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
  newAppListingReportId: () => `alr_test_${++ids.n}`,
  newUlid: () => `ULIDTEST${++ids.n}`,
}));

const MOD = 7;
const OWNER = 42;

/** The approved onsite listing being reset. */
const onsiteListing = {
  id: 'apl_1',
  kind: 'onsite',
  status: 'approved',
  slug: 'my-app',
  name: 'My App',
  userId: OWNER,
  appBlockId: 'apb_1',
};

/** The latest approved block publish request cloned into the fresh pending one. */
const lastApprovedReq = {
  appBlockId: 'apb_1',
  version: '1.2.0',
  manifest: { blockId: 'my-app', scopes: [] },
  bundleKey: 'bundles/deadbeef.zip',
  bundleSha256: 'deadbeef',
  bundleSizeBytes: BigInt(1024),
  fileSummary: { files: [], added: [], removed: [], changed: [] },
  manifestDiffSummary: { kind: 'update' },
  forgejoCommitSha: 'sha_abc',
};

beforeEach(() => {
  ids.n = 0;
  mockRead.appListing.findUnique.mockReset().mockResolvedValue(onsiteListing);
  mockRead.appBlockPublishRequest.findFirst.mockReset();
  // Default: (1) latest-approved lookup returns a clonable request, (2) open-pending
  // lookup returns none.
  mockRead.appBlockPublishRequest.findFirst
    .mockResolvedValueOnce(lastApprovedReq)
    .mockResolvedValueOnce(null);
  mockWrite.$transaction
    .mockReset()
    .mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite));
  mockWrite.appListing.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockWrite.appBlock.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mockWrite.appBlockPublishRequest.create
    .mockReset()
    .mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListingModerationEvent.create
    .mockReset()
    .mockImplementation(async (a: { data: unknown }) => a.data);
  mockNotify.mockReset().mockResolvedValue(undefined);
});

describe('resetOnsiteListingToPending', () => {
  it('happy path: flips listing→pending, SUSPENDS the block, clones a fresh pending request, writes reset-to-pending, notifies', async () => {
    const res = await resetOnsiteListingToPending({
      input: { appListingId: 'apl_1', reason: 'needs another look' },
      reviewerUserId: MOD,
    });

    // (1) listing approved → pending, onsite + status-guarded.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: 'apl_1', kind: 'onsite', status: 'approved' },
      data: { status: 'pending' },
    });
    // (2) backing block approved → suspended (the real runtime stop).
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: 'apb_1', status: 'approved' },
      data: { status: 'suspended' },
    });
    // (3) fresh pending block publish request cloned from the last approved (owner-owned).
    const reqArg = mockWrite.appBlockPublishRequest.create.mock.calls[0][0].data;
    expect(reqArg).toMatchObject({
      slug: 'my-app',
      status: 'pending',
      submittedByUserId: OWNER,
      version: '1.2.0',
      bundleKey: 'bundles/deadbeef.zip',
      bundleSha256: 'deadbeef',
      forgejoCommitSha: 'sha_abc',
      appBlockId: 'apb_1',
    });
    expect(reqArg.id).toMatch(/^pubreq_/);
    expect(typeof reqArg.bundleSizeBytes).toBe('bigint');
    // (4) reset-to-pending audit event (acting mod).
    const evtArg = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(evtArg).toMatchObject({
      appListingId: 'apl_1',
      action: 'reset-to-pending',
      actorUserId: MOD,
      before: { status: 'approved' },
      after: { status: 'pending' },
    });
    // Owner notified post-commit.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-listing-reset-to-pending', userId: OWNER })
    );
    expect(res).toMatchObject({ appListingId: 'apl_1', status: 'pending' });
    expect(res.publishRequestId).toMatch(/^pubreq_/);
  });

  it('NOT_FOUND for a missing listing', async () => {
    mockRead.appListing.findUnique.mockReset().mockResolvedValue(null);
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'nope', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('NOT_FOUND for an OFF-SITE listing (kind guard — no onsite dual-table flip)', async () => {
    mockRead.appListing.findUnique
      .mockReset()
      .mockResolvedValue({ ...onsiteListing, kind: 'offsite', appBlockId: null });
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('NOT_TRANSITIONABLE when the app has no approved version to re-review', async () => {
    mockRead.appBlockPublishRequest.findFirst.mockReset().mockResolvedValue(null);
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('NOT_TRANSITIONABLE when a review is already pending for the slug', async () => {
    mockRead.appBlockPublishRequest.findFirst
      .mockReset()
      .mockResolvedValueOnce(lastApprovedReq) // latest approved
      .mockResolvedValueOnce({ id: 'pubreq_open' }); // an open pending request exists
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('NOT_TRANSITIONABLE when the guarded listing flip matches 0 rows (raced out of approved)', async () => {
    mockWrite.appListing.updateMany.mockReset().mockResolvedValue({ count: 0 });
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    // The tx rolled back before any event/clone was written.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('maps a P2002 one-pending-per-slug race on the clone to NOT_TRANSITIONABLE', async () => {
    mockWrite.appBlockPublishRequest.create
      .mockReset()
      .mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'reason here' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
  });

  it('rejects a too-short reason (BAD_REQUEST, before any read/write)', async () => {
    await expect(
      resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'x' },
        reviewerUserId: MOD,
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('is an OffsiteModerationError instance (duck-typed by mapOffsiteError)', async () => {
    mockRead.appListing.findUnique.mockReset().mockResolvedValue(null);
    await resetOnsiteListingToPending({
      input: { appListingId: 'nope', reason: 'reason here' },
      reviewerUserId: MOD,
    }).catch((err) => {
      expect(err).toBeInstanceOf(OffsiteModerationError);
    });
  });
});
