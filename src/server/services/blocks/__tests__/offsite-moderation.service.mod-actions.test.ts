import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import {
  OffsiteModerationError,
  claimListing,
  delistListing,
  dismissReport,
  listModerationEvents,
  purgeListing,
  relistListing,
  resolveReport,
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
    // purge + claim re-read the pre-mutation snapshot on the PRIMARY inside the tx.
    findUnique: ReturnType<typeof vi.fn>;
  };
  appListingModerationEvent: { create: ReturnType<typeof vi.fn> };
  appListingReport: { updateMany: ReturnType<typeof vi.fn> };
  // claim validates the target owner on the primary inside the tx.
  user: { findUnique: ReturnType<typeof vi.fn> };
  // NEVER touched by claim (the submitter record is preserved) — asserted by absence.
  appListingPublishRequest: { updateMany: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReport: { findUnique: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { findMany: ReturnType<typeof vi.fn> };
};

const { mockRead, mockWrite, ids } = vi.hoisted(() => {
  const write: WriteMock = {
    $transaction: vi.fn(),
    appListing: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(async () => null),
    },
    appListingModerationEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
    appListingReport: { updateMany: vi.fn(async () => ({ count: 1 })) },
    user: { findUnique: vi.fn(async () => ({ id: 1 })) },
    appListingPublishRequest: { updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  // The tx client is the write mock itself, so tx.* calls land on the same spies.
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReport: { findUnique: vi.fn(async () => null) },
    appListingModerationEvent: { findMany: vi.fn(async () => []) },
  };
  return { mockRead: read, mockWrite: write, ids: { n: 0 } };
});

vi.mock('~/server/db/client', () => ({ dbRead: mockRead, dbWrite: mockWrite }));
vi.mock('~/server/utils/app-block-ids', () => ({
  newAppListingReportId: () => `alrp_test_${++ids.n}`,
  newAppListingModerationEventId: () => `alme_test_${++ids.n}`,
}));

const REVIEWER = 1001;
const APP_ID = 'apl_target';
const SLUG = 'cool-app';
const REPORT_ID = 'alrp_r1';
const GOOD_REASON = 'impersonates a real vendor';

function offsiteListing(status: string, kind = 'offsite') {
  return { id: APP_ID, kind, status, slug: SLUG };
}

beforeEach(() => {
  ids.n = 0;
  vi.clearAllMocks();
  mockWrite.$transaction.mockImplementation(
    async (cb: (tx: WriteMock) => Promise<unknown>) => cb(mockWrite)
  );
  mockWrite.appListing.updateMany.mockResolvedValue({ count: 1 });
  mockWrite.appListing.deleteMany.mockResolvedValue({ count: 1 });
  // Default the in-tx purge primary read to a valid offsite listing (overridden
  // per-test where the snapshot status is load-bearing).
  mockWrite.appListing.findUnique.mockResolvedValue(offsiteListing('removed'));
  mockWrite.appListingModerationEvent.create.mockImplementation(async (a: { data: unknown }) => a.data);
  mockWrite.appListingReport.updateMany.mockResolvedValue({ count: 1 });
  // claim: default the target-owner lookup to a real user + the reassign to 1 row.
  mockWrite.user.findUnique.mockResolvedValue({ id: 42 });
  mockWrite.appListingPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  mockRead.appListing.findUnique.mockResolvedValue(null);
  mockRead.appListingReport.findUnique.mockResolvedValue(null);
  mockRead.appListingModerationEvent.findMany.mockResolvedValue([]);
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

    // The mutate is status+kind-guarded (approved-only, offsite-only).
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'approved' },
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
  });

  it('a status-guarded 0-count (already removed/draft) → NOT_TRANSITIONABLE and ZERO events', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_TRANSITIONABLE' });
    // Guard threw BEFORE the audit write — no event on a rolled-back mutation.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('an ON-SITE listing is rejected by the kind guard (generic NOT_FOUND, no tx)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved', 'onsite'));
    await expect(
      delistListing({ input: { appListingId: APP_ID, reason: GOOD_REASON }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_FOUND' });
    expect(mockWrite.$transaction).not.toHaveBeenCalled();
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

describe('OffsiteModerationError (PR3/PR4 codes)', () => {
  it('carries the NOT_TRANSITIONABLE / REPORT_NOT_PENDING / INVALID_TARGET_USER codes', () => {
    expect(new OffsiteModerationError('NOT_TRANSITIONABLE', 'x').code).toBe('NOT_TRANSITIONABLE');
    expect(new OffsiteModerationError('REPORT_NOT_PENDING', 'x').code).toBe('REPORT_NOT_PENDING');
    expect(new OffsiteModerationError('INVALID_TARGET_USER', 'x').code).toBe('INVALID_TARGET_USER');
  });
});
