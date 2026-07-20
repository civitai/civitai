import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OffsiteModerationError,
  claimListing,
  delistListing,
  dismissReport,
  listModerationEvents,
  listMyListingModerationEvents,
  purgeListing,
  relistListing,
  republishOwnListing,
  resetListingToPending,
  resolveReport,
  unpublishOwnListing,
} from '~/server/services/blocks/offsite-moderation.service';

/**
 * W13 P3b PR3 — off-site moderation ACTION service tests (delist / relist / purge
 * / resolve / dismiss + the moderation-history read). All DB deps are mocked — no
 * real Prisma. `dbWrite.$transaction` runs its callback against the SAME `dbWrite`
 * mock (the tx client), so a test asserts the exact status-guarded writes + that a
 * guarded 0-count throws BEFORE any audit event is written (zero events on a
 * guarded mutation), and that purge writes its event BEFORE the delete.
 */

type WriteMock = {
  $transaction: ReturnType<typeof vi.fn>;
  appListing: {
    updateMany: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    // purge + claim + reset + owner actions re-read the snapshot on the PRIMARY in-tx.
    findUnique: ReturnType<typeof vi.fn>;
  };
  // On-site delist/relist flip the backing AppBlock's status in the same tx.
  appBlock: { updateMany: ReturnType<typeof vi.fn> };
  appListingModerationEvent: {
    create: ReturnType<typeof vi.fn>;
    // republish reads the LATEST event on the primary inside the tx.
    findFirst: ReturnType<typeof vi.fn>;
  };
  appListingReport: { updateMany: ReturnType<typeof vi.fn> };
  // claim validates the target owner on the primary inside the tx.
  user: { findUnique: ReturnType<typeof vi.fn> };
  // claim NEVER writes this (submitter preserved); reset CREATES a fresh pending request.
  appListingPublishRequest: {
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReport: { findUnique: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { findMany: ReturnType<typeof vi.fn> };
};

const { mockRead, mockWrite, mockNotify, mockLogToAxiom, ids } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListing: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
    },
    appBlock: { updateMany: vi.fn(async () => ({ count: 1 })) },
    appListingModerationEvent: {
      create: vi.fn(async (a: { data: unknown }) => a.data),
      findFirst: vi.fn(async () => null),
    },
    appListingReport: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => ({ id: 1 })) },
    appListingPublishRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async (a: { data: unknown }) => a.data),
    },
  };
  // The tx client is the write mock itself, so tx.* calls land on the same spies.
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReport: { findUnique: vi.fn(async () => null) },
    appListingModerationEvent: { findMany: vi.fn(async () => []) },
  };
  return {
    mockRead: read,
    mockWrite: write,
    mockNotify: vi.fn(async () => undefined),
    mockLogToAxiom: vi.fn(async () => undefined),
    ids: { n: 0 },
  };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
// The on-site relist / owner-republish drift warn is a dynamic import of this module.
vi.mock('~/server/logging/client', () => ({ logToAxiom: mockLogToAxiom }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
  newAppListingPublishRequestId: () => `alpr_test_${++ids.n}`,
}));
// Assert owner-notification emission without pulling the notifications client graph.
vi.mock('~/server/services/blocks/app-listing-notify', () => ({ notifyAppListingOwner: mockNotify }));

const REVIEWER = 1001;
const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const REPORT_ID = 'alrp_r1';
const GOOD_REASON = 'impersonates a real vendor';

const OWNER = 500;
const BLOCK_ID = 'blk_backing';

/** Replica classify shape — carries userId + name + appBlockId (dual-action classify). */
function offsiteListing(status: string, kind = 'offsite') {
  return { id: APP_ID, kind, status, slug: SLUG, name: 'Cool App', userId: OWNER, appBlockId: null };
}
/** An on-site listing carries a backing AppBlock id (dual-table flip target). */
function onsiteListing(status: string) {
  return {
    id: APP_ID,
    kind: 'onsite',
    status,
    slug: SLUG,
    name: 'Cool App',
    userId: OWNER,
    appBlockId: BLOCK_ID,
  };
}

beforeEach(() => {
  ids.n = 0;
  vi.clearAllMocks();
  mockWrite.$transaction.mockImplementation(
    async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite)
  );
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  mockWrite.appBlock.updateMany.mockResolvedValue({ count: 1 });
  // Default the in-tx purge primary read to a valid offsite listing (overridden
  // per-test where the snapshot status is load-bearing).
  mockWrite.appListing.findUnique.mockResolvedValue(offsiteListing('removed'));
  mockWrite.appListingModerationEvent.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListingModerationEvent.findFirst.mockResolvedValue(null);
  mockWrite.appListingReport.updateMany.mockResolvedValue({ count: 1 });
  // claim: default the target-owner lookup to a real user + the reassign to 1 row.
  mockWrite.user.findUnique.mockResolvedValue({ id: 42 });
  mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListingPublishRequest.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListingReport.findUnique.mockResolvedValue(null);
  mockRead.appListingModerationEvent.findMany.mockResolvedValue([]);
  mockNotify.mockResolvedValue(undefined);
  mockLogToAxiom.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// delistListing
// ---------------------------------------------------------------------------

describe('delistListing', () => {
  it('flips approved → removed (status+kind-guarded) and writes exactly ONE delist event', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    const res = await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });

    // The mutate is status+kind-guarded (approved OR removed → removed, offsite-only).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: { in: ['approved', 'removed'] } },
      data: { status: 'removed' },
    });
    // Exactly ONE audit event, with the correct action/actor/reason/slug/before/after.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      appListingId: APP_ID,
      slug: SLUG,
      action: 'delist',
      actorUserId: REVIEWER,
      reason: GOOD_REASON,
      before: { status: 'approved' },
      after: { status: 'removed' },
      reportId: null,
    });
    // No linked report → the report table is untouched.
    expect(mockWrite.appListingReport.updateMany).not.toHaveBeenCalled();
    // OFF-SITE hide → the owner is notified (post-commit), carrying the reason.
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app-listing-hidden',
        userId: OWNER,
        details: expect.objectContaining({ slug: SLUG, reason: GOOD_REASON }),
      })
    );
    // OFF-SITE has no backing block to suspend.
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });

  it('ON-SITE delist flips BOTH app_listings AND the backing app_blocks in one tx (no owner notif)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(onsiteListing('approved'));
    const res = await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });
    // The listing flip is kind-scoped to onsite (approved OR removed → removed).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'onsite', status: { in: ['approved', 'removed'] } },
      data: { status: 'removed' },
    });
    // The backing AppBlock is ALSO suspended (guarded approved→suspended) in the tx.
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'approved' },
      data: { status: 'suspended' },
    });
    // Still exactly one audit event.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.action).toBe('delist');
    // ON-SITE owners are NOT notified in Phase 1.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a status-guarded 0-count (concurrently moved out of {approved,removed}, e.g. to draft/pending) → NOT_TRANSITIONABLE, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_TRANSITIONABLE' });
    // Guard threw BEFORE the audit write — no event on a rolled-back mutation.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    // Rolled back → no owner notification.
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('🔴 ENFORCED-TAKEDOWN LOCK: delist on an already-REMOVED (owner-unpublished) listing succeeds + writes a delist event (before status removed)', async () => {
    // The owner previously self-unpublished (status removed). A mod delist is idempotent
    // (stays removed) but ALWAYS writes a `delist` event → the LAST event is now a mod
    // takedown, so republishOwnListing's guard forbids the owner re-exposing it.
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    const res = await delistListing({
      input: { appListingId: APP_ID, reason: 'confirmed impersonation' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: { in: ['approved', 'removed'] } },
      data: { status: 'removed' },
    });
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'delist',
      // The pre-state is reflected accurately (removed, not a hardcoded approved).
      before: { status: 'removed' },
      after: { status: 'removed' },
    });
  });

  it('a missing listing → generic NOT_FOUND (indistinguishable from on-site)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(null);
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('with a reportId, resolves that report in the SAME tx (status+listing-scoped)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON, reportId: REPORT_ID },
      reviewerUserId: REVIEWER,
    });
    // The resolve is scoped to THIS listing (appListingId) AND the pending status —
    // so a reportId for another listing can't be closed by this delist.
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, appListingId: APP_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    // The event carries the reportId link.
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.reportId).toBe(REPORT_ID);
  });

  it('a reportId belonging to a DIFFERENT listing is NOT resolved (0-row no-op); the delist still succeeds', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    // The listing-scoped, status-guarded updateMany matches 0 rows (the report is
    // for another listing) — the delist must still succeed (silent no-op).
    mockWrite.appListingReport.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await delistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON, reportId: REPORT_ID },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });
    // The WHERE is scoped to THIS listing, so a cross-listing report can never match.
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, appListingId: APP_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    // The delist event still stands + still links the supplied reportId.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.action).toBe('delist');
  });

  it('a too-short reason is a BAD_REQUEST (defense-in-depth) with no DB touch', async () => {
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: 'x' }, reviewerUserId: REVIEWER })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// relistListing
// ---------------------------------------------------------------------------

describe('relistListing', () => {
  it('flips removed → approved (guarded) + one relist event with swapped before/after', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    const res = await relistListing({
      input: { appListingId: APP_ID, reason: 'appeal upheld' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: 'relist',
      before: { status: 'removed' },
      after: { status: 'approved' },
    });
  });

  it('relisting a non-removed row → NOT_TRANSITIONABLE, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('ON-SITE relist restores BOTH app_listings AND the backing app_blocks in one tx', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(onsiteListing('removed'));
    const res = await relistListing({
      input: { appListingId: APP_ID, reason: 'appeal upheld' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'onsite', status: 'removed' },
      data: { status: 'approved' },
    });
    // The backing AppBlock is restored (guarded suspended→approved).
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'suspended' },
      data: { status: 'approved' },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.action).toBe('relist');
  });

  it('OFF-SITE relist does NOT touch app_blocks', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    await relistListing({
      input: { appListingId: APP_ID, reason: 'appeal upheld' },
      reviewerUserId: REVIEWER,
    });
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// claimListing
// ---------------------------------------------------------------------------

describe('claimListing', () => {
  const OLD_OWNER = 500;
  const TARGET = 42;

  /** The in-tx PRIMARY snapshot shape claim reads (userId + status + slug + kind). */
  function primarySnapshot(status: string, kind = 'offsite', userId = OLD_OWNER) {
    return { userId, status, slug: SLUG, kind };
  }

  it('reassigns userId on an APPROVED listing + writes exactly ONE claim event (before/after userId)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    const res = await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, userId: TARGET });

    // The reassign is status+kind-guarded (approved|removed, offsite-only).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: { in: ['approved', 'removed'] } },
      data: { userId: TARGET },
    });
    // Exactly ONE audit event, capturing the ownership transfer.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      appListingId: APP_ID,
      slug: SLUG,
      action: 'claim',
      actorUserId: REVIEWER,
      reason: GOOD_REASON,
      before: { userId: OLD_OWNER },
      after: { userId: TARGET },
      reportId: null,
    });
    // No linked report → the report table is untouched.
    expect(mockWrite.appListingReport.updateMany).not.toHaveBeenCalled();
  });

  it('with a reportId, resolves that report in the SAME tx (status+listing-scoped) + links it on the event', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON, reportId: REPORT_ID },
      reviewerUserId: REVIEWER,
    });
    // Scoped to THIS listing (appListingId) AND pending — a reportId for another
    // listing can't be closed by this claim (mirrors delist EXACTLY).
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, appListingId: APP_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    // The claim event carries the reportId link.
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.reportId).toBe(REPORT_ID);
  });

  it('a reportId belonging to a DIFFERENT listing is NOT resolved (0-row no-op); the claim still succeeds', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    // The listing-scoped, status-guarded updateMany matches 0 rows (report is for
    // another listing) — the claim must still succeed (silent no-op).
    mockWrite.appListingReport.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON, reportId: REPORT_ID },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, userId: TARGET });
    // The WHERE is scoped to THIS listing, so a cross-listing report can never match.
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, appListingId: APP_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    // The claim event still stands + still links the supplied reportId.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.action).toBe('claim');
  });

  it('reassigns userId on a REMOVED (delisted) listing too', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('removed'));
    const res = await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, userId: TARGET });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.after).toEqual({
      userId: TARGET,
    });
  });

  it('leaves AppListingPublishRequest.submittedByUserId INTACT (never touches the publish request)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    // The locked decision: claim reassigns AppListing.userId only — the historical
    // submission record is preserved. The publish-request table is NEVER written.
    expect(mockWrite.appListingPublishRequest.updateMany).not.toHaveBeenCalled();
  });

  it('a draft/pending/rejected status → NOT_TRANSITIONABLE, ZERO events, no reassign', async () => {
    for (const status of ['draft', 'pending', 'rejected']) {
      vi.clearAllMocks();
      mockWrite.$transaction.mockImplementation(
        async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite)
      );
      mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing(status));
      mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot(status));
      await expect(
        claimListing({
          input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
          reviewerUserId: REVIEWER,
        })
      ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_TRANSITIONABLE' });
      expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
      expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    }
  });

  it('an ON-SITE listing is rejected by the kind guard (generic NOT_FOUND, no tx)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved', 'onsite'));
    await expect(
      claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a nonexistent targetUserId → friendly INVALID_TARGET_USER, no reassign, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    // The target-owner lookup finds no user.
    mockWrite.user.findUnique.mockResolvedValueOnce(null);
    await expect(
      claimListing({
        input: { appListingId: APP_ID, targetUserId: 999999, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'INVALID_TARGET_USER' });
    // Guarded before the reassign + the event write.
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('a status-guarded updateMany 0-count (TOCTOU) → NOT_TRANSITIONABLE, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    // The row was moved out of {approved,removed} between the snapshot and the write.
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('snapshots before.userId from the in-tx PRIMARY read, not the (lagging) replica classify', async () => {
    // The replica classify sees a stale row; the primary tx read sees the TRUE owner.
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved', 'offsite', 777));
    await claimListing({
      input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(mockWrite.appListing.findUnique).toHaveBeenCalledWith({
      where: { id: APP_ID },
      select: { userId: true, status: true, slug: true, kind: true },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.before).toEqual({
      userId: 777,
    });
  });

  it('a too-short reason is a BAD_REQUEST (defense-in-depth) with no DB touch', async () => {
    await expect(
      claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: 'x' },
        reviewerUserId: REVIEWER,
      })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// purgeListing
// ---------------------------------------------------------------------------

describe('purgeListing', () => {
  it('writes the audit event BEFORE the hard delete (so the event captures the snapshot)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    const res = await purgeListing({
      input: { appListingId: APP_ID, reason: 'confirmed impersonation' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, purged: true });

    // ORDER: event.create must be invoked before appListing.deleteMany.
    const createOrder = mockWrite.appListingModerationEvent.create.mock.invocationCallOrder[0];
    const deleteOrder = mockWrite.appListing.deleteMany.mock.invocationCallOrder[0];
    expect(createOrder).toBeLessThan(deleteOrder);

    // The event snapshots the pre-delete status + slug; the delete targets the id
    // (kind-guarded — offsite-only, defense-in-depth on the destructive op).
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'purge',
      slug: SLUG,
      before: { status: 'removed' },
    });
    expect(mockWrite.appListing.deleteMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite' },
    });
  });

  it('purges regardless of the source status (approved allowed), snapshotting it', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    await purgeListing({
      input: { appListingId: APP_ID, reason: 'spam expunge' },
      reviewerUserId: REVIEWER,
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.before).toEqual({
      status: 'approved',
    });
  });

  it('snapshots before.status + slug from the in-tx PRIMARY read, not the (lagging) replica classify', async () => {
    // Replica classify sees a STALE `approved`/old-slug; the primary tx read sees the
    // true current `removed`/new-slug. The audit `before` must reflect the PRIMARY.
    mockRead.appListing.findUnique.mockResolvedValueOnce({
      id: APP_ID,
      kind: 'offsite',
      status: 'approved',
      slug: 'stale-slug',
    });
    mockWrite.appListing.findUnique.mockResolvedValueOnce({
      status: 'removed',
      slug: 'fresh-slug',
      kind: 'offsite',
    });
    await purgeListing({
      input: { appListingId: APP_ID, reason: 'confirmed impersonation' },
      reviewerUserId: REVIEWER,
    });
    // The in-tx primary read is what feeds the snapshot.
    expect(mockWrite.appListing.findUnique).toHaveBeenCalledWith({
      where: { id: APP_ID },
      select: { status: true, slug: true, kind: true },
    });
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data.before).toEqual({ status: 'removed' });
    expect(data.slug).toBe('fresh-slug');
  });

  it('the kind guard rejects an on-site listing at the replica classify (no tx)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed', 'onsite'));
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: 'spam expunge' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a row that vanished/turned non-offsite between classify and the in-tx primary read → NOT_FOUND, ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    // Passed the replica classify, but the primary tx read finds it gone.
    mockWrite.appListing.findUnique.mockResolvedValueOnce(null);
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: 'spam expunge' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Guard threw before the event write.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockWrite.appListing.deleteMany).not.toHaveBeenCalled();
  });

  it('a raced delete (0-count) → NOT_FOUND', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      purgeListing({ input: { appListingId: APP_ID, reason: 'spam expunge' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// resolveReport / dismissReport
// ---------------------------------------------------------------------------

describe('resolveReport / dismissReport', () => {
  const report = { id: REPORT_ID, status: 'pending', appListingId: APP_ID, appListing: { slug: SLUG } };

  it('resolveReport flips pending → resolved (guarded) + a report-resolve event with the note', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(report);
    await resolveReport({ input: { reportId: REPORT_ID, note: '  handled  ' }, reviewerUserId: REVIEWER });
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, status: 'pending' },
      data: { status: 'resolved', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'report-resolve',
      reportId: REPORT_ID,
      slug: SLUG,
      reason: 'handled', // trimmed note
      before: { status: 'pending' },
      after: { status: 'resolved' },
    });
  });

  it('dismissReport flips pending → dismissed + a report-dismiss event; empty note → null reason', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(report);
    await dismissReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER });
    expect(mockWrite.appListingReport.updateMany).toHaveBeenCalledWith({
      where: { id: REPORT_ID, status: 'pending' },
      data: { status: 'dismissed', resolvedByUserId: REVIEWER, resolvedAt: expect.any(Date) },
    });
    const data = mockWrite.appListingModerationEvent.create.mock.calls[0][0].data;
    expect(data.action).toBe('report-dismiss');
    expect(data.reason).toBeNull();
  });

  it('a non-pending report → REPORT_NOT_PENDING, ZERO events', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce({ ...report, status: 'resolved' });
    mockWrite.appListingReport.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      resolveReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'REPORT_NOT_PENDING' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('a missing report → NOT_FOUND (no tx)', async () => {
    mockRead.appListingReport.findUnique.mockResolvedValueOnce(null);
    await expect(
      dismissReport({ input: { reportId: REPORT_ID }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listModerationEvents
// ---------------------------------------------------------------------------

describe('listModerationEvents', () => {
  const evt = (id: string) => ({
    id,
    appListingId: APP_ID,
    slug: SLUG,
    action: 'delist',
    reason: 'r',
    detail: null,
    before: { status: 'approved' },
    after: { status: 'removed' },
    reportId: null,
    createdAt: new Date(),
    actor: { id: REVIEWER, username: 'mod', image: null },
  });

  it('is newest-first with an id tie-break, capped at 50, keyset-paginated', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([
      evt('alme_3'),
      evt('alme_2'),
      evt('alme_1'),
    ]);
    const res = await listModerationEvents({ appListingId: APP_ID, limit: 2 });
    expect(res.items).toHaveLength(2);
    expect(res.nextCursor).toBe('alme_2');

    const args = mockRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ appListingId: APP_ID });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(3); // 2 + 1
  });

  it('caps limit at 50 and projects a PII-safe shape (actor chip, no raw actorUserId FK)', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([]);
    await listModerationEvents({ appListingId: APP_ID, limit: 999 });
    const args = mockRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(args.take).toBe(51);
    expect(args.select.actor).toEqual({ select: { id: true, username: true, image: true } });
    expect(args.select.actorUserId).toBeUndefined();
  });

  it('nextCursor is null on the last page', async () => {
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([evt('alme_1')]);
    const res = await listModerationEvents({ appListingId: APP_ID });
    expect(res.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// resetListingToPending (W13 post-approval mgmt) — MOD bounce back to review.
// ---------------------------------------------------------------------------

describe('resetListingToPending', () => {
  /** The in-tx PRIMARY snapshot shape reset reads (userId + status + kind + slug + name). */
  function primary(status: string, kind = 'offsite') {
    return { userId: OWNER, status, kind, slug: SLUG, name: 'Cool App' };
  }

  it('flips approved → pending, mints a fresh pending request owned by the OWNER, writes ONE reset event + notifies', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primary('approved'));
    const res = await resetListingToPending({
      input: { appListingId: APP_ID, reason: GOOD_REASON },
      reviewerUserId: REVIEWER,
    });
    expect(res).toMatchObject({ appListingId: APP_ID, status: 'pending' });
    expect(res.publishRequestId).toMatch(/^alpr_test_/);

    // Guarded flip approved → pending (offsite).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'approved' },
      data: { status: 'pending' },
    });
    // A fresh pending request re-enters the queue, SUBMITTED-BY THE OWNER (not the mod).
    expect(mockWrite.appListingPublishRequest.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingPublishRequest.create.mock.calls[0][0].data).toMatchObject({
      appListingId: APP_ID,
      kind: 'offsite',
      slug: SLUG,
      submittedByUserId: OWNER,
      status: 'pending',
    });
    // Exactly one reset-to-pending audit event.
    expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'reset-to-pending',
      actorUserId: REVIEWER,
      reason: GOOD_REASON,
      before: { status: 'approved' },
      after: { status: 'pending' },
    });
    // Owner notified their app needs re-review.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app-listing-reset-to-pending',
        userId: OWNER,
        details: expect.objectContaining({ slug: SLUG, reason: GOOD_REASON }),
      })
    );
  });

  it('a non-approved (guard 0-count) listing → NOT_TRANSITIONABLE, ZERO events/requests/notif', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValueOnce(primary('removed'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      resetListingToPending({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a missing / on-site listing → generic NOT_FOUND (offsite-only), no tx', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved', 'onsite'));
    await expect(
      resetListingToPending({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
  });

  it('a too-short reason is a BAD_REQUEST with no DB touch', async () => {
    await expect(
      resetListingToPending({ input: { appListingId: APP_ID, reason: 'x' }, reviewerUserId: REVIEWER })
    ).rejects.toBeInstanceOf(TRPCError);
    expect(mockRead.appListing.findUnique).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// unpublishOwnListing / republishOwnListing (owner) — the safety guard is load-bearing.
// ---------------------------------------------------------------------------

describe('unpublishOwnListing', () => {
  function ownerPrimary(status: string, kind = 'offsite', userId = OWNER, appBlockId: string | null = null) {
    return { userId, status, kind, slug: SLUG, name: 'Cool App', appBlockId };
  }

  it('OWNER hides their approved OFF-SITE listing (approved → removed) + one owner-unpublish event, no notif/publish-request/block-flip', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('approved'));
    const res = await unpublishOwnListing({
      input: { appListingId: APP_ID },
      userId: OWNER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'approved' },
      data: { status: 'removed' },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'owner-unpublish',
      actorUserId: OWNER,
      before: { status: 'approved' },
      after: { status: 'removed' },
    });
    // OFF-SITE: no backing block to suspend.
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    // Pure visibility toggle — no re-review artifact, no owner self-notification.
    expect(mockWrite.appListingPublishRequest.create).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('🔴 ON-SITE full takedown: flips BOTH app_listings AND the backing app_blocks (approved → suspended) in ONE tx + owner-unpublish event', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('approved', 'onsite', OWNER, BLOCK_ID));
    const res = await unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'removed' });
    // The listing flip is kind-scoped to onsite.
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'onsite', status: 'approved' },
      data: { status: 'removed' },
    });
    // The backing block is suspended (guarded to approved) so the runtime stops serving.
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'approved' },
      data: { status: 'suspended' },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'owner-unpublish',
      before: { status: 'approved' },
      after: { status: 'removed' },
    });
  });

  it('a NON-owner caller → NOT_OWNED (FORBIDDEN), no flip/event', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('approved', 'offsite', OWNER));
    await expect(
      unpublishOwnListing({ input: { appListingId: APP_ID }, userId: 999 })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_OWNED' });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('a non-approved owned listing → NOT_TRANSITIONABLE', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed'));
    await expect(
      unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('a missing listing → generic NOT_FOUND', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(null);
    await expect(
      unpublishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('republishOwnListing (🔴 the last-event safety guard)', () => {
  function ownerPrimary(status: string, kind = 'offsite', userId = OWNER, appBlockId: string | null = null) {
    return { userId, status, kind, slug: SLUG, name: 'Cool App', appBlockId };
  }

  it('OWNER restores their OWN owner-unpublished OFF-SITE listing (removed → approved) + owner-republish event, no block-flip', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed'));
    // The most-recent event is the owner's own unpublish → restore allowed.
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'owner-republish',
      before: { status: 'removed' },
      after: { status: 'approved' },
    });
  });

  it('🔴 ON-SITE republish restores BOTH app_listings AND the backing app_blocks (suspended → approved) in ONE tx + owner-republish event', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed', 'onsite', OWNER, BLOCK_ID));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'onsite', status: 'removed' },
      data: { status: 'approved' },
    });
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: BLOCK_ID, status: 'suspended' },
      data: { status: 'approved' },
    });
    expect(mockWrite.appListingModerationEvent.create.mock.calls[0][0].data).toMatchObject({
      action: 'owner-republish',
    });
  });

  it('🔴 ON-SITE republish FORBIDDEN when the last event is a MOD delist — no listing flip AND no block flip', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed', 'onsite', OWNER, BLOCK_ID));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'delist' });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('ON-SITE republish whose block-restore flip is a 0-count (drift) emits the post-commit warn (observability, mirrors mod relist)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed', 'onsite', OWNER, BLOCK_ID));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    // The backing block wasn't `suspended` → the guarded block flip matches 0 rows.
    mockWrite.appBlock.updateMany.mockResolvedValueOnce({ count: 0 });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    // The listing is still restored (non-fatal) — visibility IS back.
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    // …but the block-serve divergence is warned post-commit (best-effort dynamic import).
    await vi.waitFor(() => expect(mockLogToAxiom).toHaveBeenCalledTimes(1));
    expect(mockLogToAxiom.mock.calls[0][0]).toMatchObject({
      type: 'warning',
      name: 'app-listing-relist-block-drift',
      details: { appListingId: APP_ID, appBlockId: BLOCK_ID },
    });
  });

  it('🔴 FORBIDDEN when the last event is a MOD delist (takedown-for-cause) — no flip, no event', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed'));
    // The most-recent event is a moderator delist → owner may NOT self-restore.
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'delist' });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'FORBIDDEN' });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 FORBIDDEN when the last event is a MOD purge', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed'));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'purge' });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('FORBIDDEN when there is NO prior event (cannot prove owner-initiated removal)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed'));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce(null);
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('a NON-owner caller → NOT_OWNED (FORBIDDEN)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('removed', 'offsite', OWNER));
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: 999 })
    ).rejects.toMatchObject({ code: 'NOT_OWNED' });
    // Ownership fails before the last-event check + the flip.
    expect(mockWrite.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('a non-removed owned listing → NOT_TRANSITIONABLE (before the last-event check)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValueOnce(ownerPrimary('approved'));
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
    expect(mockWrite.appListingModerationEvent.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// listMyListingModerationEvents (owner-scoped history).
// ---------------------------------------------------------------------------

describe('listMyListingModerationEvents', () => {
  const evt = (id: string) => ({
    id,
    appListingId: APP_ID,
    slug: SLUG,
    action: 'owner-unpublish',
    reason: null,
    detail: null,
    before: { status: 'approved' },
    after: { status: 'removed' },
    reportId: null,
    createdAt: new Date(),
    actor: { id: OWNER, username: 'dev', image: null },
  });

  it('returns the OWN-listing events (owner-authz) with the same newest-first keyset shape', async () => {
    // Ownership check reads the listing owner...
    mockRead.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });
    // ...then the events query returns the page.
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([evt('alme_2'), evt('alme_1')]);
    const res = await listMyListingModerationEvents({
      input: { appListingId: APP_ID, limit: 1 },
      userId: OWNER,
    });
    expect(res.items).toHaveLength(1);
    expect(res.nextCursor).toBe('alme_2');
    const args = mockRead.appListingModerationEvent.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ appListingId: APP_ID });
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('🔴 uses the OWNER-scoped projection — NO acting-mod identity / reportId / detail / snapshots', async () => {
    // Privacy guard: a taken-down app's owner must not learn WHICH moderator acted
    // (harassment vector) nor read internal report/detail fields. The owner read must
    // request ONLY {id, action, reason, createdAt} — dropping actor/reportId/detail/
    // before/after (which the MOD-facing read keeps). Asserted on the `select` the proc
    // passes to Prisma (the source of truth for what leaves the DB).
    mockRead.appListing.findUnique.mockResolvedValueOnce({ userId: OWNER });
    mockRead.appListingModerationEvent.findMany.mockResolvedValueOnce([evt('alme_1')]);
    await listMyListingModerationEvents({ input: { appListingId: APP_ID }, userId: OWNER });
    const select = mockRead.appListingModerationEvent.findMany.mock.calls[0][0].select as Record<
      string,
      unknown
    >;
    expect(select).toEqual({ id: true, action: true, reason: true, createdAt: true });
    for (const dropped of ['actor', 'reportId', 'detail', 'before', 'after', 'appListingId', 'slug']) {
      expect(select).not.toHaveProperty(dropped);
    }
  });

  it('FORBIDDEN (NOT_OWNED) on a listing the caller does NOT own — no events read', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce({ userId: 12345 });
    await expect(
      listMyListingModerationEvents({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_OWNED' });
    expect(mockRead.appListingModerationEvent.findMany).not.toHaveBeenCalled();
  });

  it('NOT_FOUND on a missing listing', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(null);
    await expect(
      listMyListingModerationEvents({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('OffsiteModerationError (PR3/PR4 + W13 codes)', () => {
  it('carries the NOT_TRANSITIONABLE / REPORT_NOT_PENDING / INVALID_TARGET_USER / NOT_OWNED / FORBIDDEN codes', () => {
    expect(new OffsiteModerationError('NOT_TRANSITIONABLE', 'x').code).toBe('NOT_TRANSITIONABLE');
    expect(new OffsiteModerationError('REPORT_NOT_PENDING', 'x').code).toBe('REPORT_NOT_PENDING');
    expect(new OffsiteModerationError('INVALID_TARGET_USER', 'x').code).toBe('INVALID_TARGET_USER');
    expect(new OffsiteModerationError('NOT_OWNED', 'x').code).toBe('NOT_OWNED');
    expect(new OffsiteModerationError('FORBIDDEN', 'x').code).toBe('FORBIDDEN');
  });
});
