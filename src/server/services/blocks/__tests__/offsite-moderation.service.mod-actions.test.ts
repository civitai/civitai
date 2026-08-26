import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

import { APP_LISTING_REPORT_REASONS } from '~/server/schema/blocks/offsite-moderation.schema';

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
  appListingReport: {
    updateMany: ReturnType<typeof vi.fn>;
    // The on-site over-rated-media review queue: republish check-then-inserts an
    // advisory `AppListingReport` in the SAME tx as the status flip.
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  // claim validates the target owner on the primary inside the tx.
  user: { findUnique: ReturnType<typeof vi.fn> };
  // claim NEVER writes this (submitter preserved); reset CREATES a fresh pending request.
  appListingPublishRequest: {
    updateMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  // relist/republish now re-read attached assets on the primary for the go-live
  // scan-clean gate (assertAssetsScanClean).
  appListingScreenshot: { findMany: ReturnType<typeof vi.fn> };
  image: { findMany: ReturnType<typeof vi.fn> };
  // 🔴 claim's SEAT REMEDIATION, in the same tx as the reassign: the impersonator's
  // seats/invites are deleted and their pending transfer is cancelled, each recorded as
  // an AppOwnershipEvent.
  appCollaborator: { findMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  appOwnershipTransfer: { updateMany: ReturnType<typeof vi.fn> };
  appOwnershipEvent: { create: ReturnType<typeof vi.fn> };
};
type ReadMock = {
  appListing: { findUnique: ReturnType<typeof vi.fn> };
  appListingReport: { findUnique: ReturnType<typeof vi.fn> };
  appListingModerationEvent: { findMany: ReturnType<typeof vi.fn> };
  // The OUT-OF-TX table-presence probe. A missing-table error here means the
  // manual-apply migration has not landed, and the remediation is skipped entirely.
  appCollaborator: { count: ReturnType<typeof vi.fn> };
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
    appListingReport: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      // Default: no OPEN review for this listing+reporter → the queue write proceeds.
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      create: vi.fn(async (a: { data: unknown }) => a.data),
    },
    user: { findUnique: vi.fn(async () => ({ id: 1 })) },
    appListingPublishRequest: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      create: vi.fn(async (a: { data: unknown }) => a.data),
    },
    // Default: no screenshots + every queried image `Scanned` → the go-live scan-clean
    // gate is a no-op for a normally-scanned listing. A scan-gate test overrides these.
    appListingScreenshot: { findMany: vi.fn(async () => []) },
    image: {
      findMany: vi.fn(async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned' }))
      ),
    },
    // claim's seat remediation, in the same tx as the reassign.
    appCollaborator: {
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown[]> => []),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    appOwnershipTransfer: { updateMany: vi.fn(async () => ({ count: 0 })) },
    appOwnershipEvent: { create: vi.fn(async (a: { data: unknown }) => a.data) },
  };
  // The tx client is the write mock itself, so tx.* calls land on the same spies.
  write.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => cb(write));
  const read: ReadMock = {
    appListing: { findUnique: vi.fn(async () => null) },
    appListingReport: { findUnique: vi.fn(async () => null) },
    appListingModerationEvent: { findMany: vi.fn(async () => []) },
    appCollaborator: { count: vi.fn(async () => 0) },
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
  // claim's seat remediation writes AppOwnershipEvents through `recordOwnershipEvent`.
  newAppOwnershipEventId: () => `aoe_test_${++ids.n}`,
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
/** A valid https destination — what makes an off-site listing publishable. */
const EXTERNAL_URL = 'https://cool.app';

/**
 * Replica classify shape — carries userId + name + appBlockId (dual-action classify).
 *
 * 🔴 `externalUrl` is part of the fixture because relist/republish are GO-LIVE
 * transitions and now run the off-site actionability gate: an off-site listing with
 * no https destination would render a store button with nothing to click and is
 * refused. A fixture without a URL does not represent a publishable off-site
 * listing at all, so the default carries one; the tests that exercise the gate
 * override it explicitly.
 */
function offsiteListing(status: string, kind = 'offsite') {
  return {
    id: APP_ID,
    kind,
    status,
    slug: SLUG,
    name: 'Cool App',
    userId: OWNER,
    appBlockId: null,
    externalUrl: EXTERNAL_URL,
    connectClientId: null,
  };
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
    // On-site listings never carry an off-site destination; the gate skips them.
    externalUrl: null,
    connectClientId: null,
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
  // Default: the collaborator tables EXIST (post-migration) and hold nothing.
  mockRead.appCollaborator.count.mockResolvedValue(0);
  mockWrite.appCollaborator.findMany.mockResolvedValue([]);
  mockWrite.appCollaborator.deleteMany.mockResolvedValue({ count: 0 });
  mockWrite.appOwnershipTransfer.updateMany.mockResolvedValue({ count: 0 });
  mockWrite.appOwnershipEvent.create.mockImplementation(async (a: { data: unknown }) => a.data);
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

  it('ON-SITE delist flips BOTH app_listings AND the backing app_blocks in one tx (+ notifies the owner)', async () => {
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
    // ON-SITE hide → the owner is notified too (the block was just suspended, so the
    // hosted app went dark — that is the case that most needs a signal).
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'app-listing-hidden',
        userId: OWNER,
        details: expect.objectContaining({ slug: SLUG, reason: GOOD_REASON }),
      })
    );
  });

  /**
   * 🔴 REGRESSION (owner-notified-on-delist, both kinds).
   *
   * A mod delist used to notify the OFF-SITE owner only; an on-site delist fired zero
   * notifications while ALSO suspending the backing block, so the author's hosted app
   * went dark with no signal. Both kinds now notify.
   *
   * The two cases carry pairwise-DISTINCT listing ids, slugs, owners and reasons so a
   * mutant that hardcodes either kind's payload (or re-notifies the wrong owner) cannot
   * satisfy both assertions.
   */
  describe('🔴 the owner is notified on delist — for BOTH kinds', () => {
    const ONSITE_ID = 'apl_onsite_target';
    const ONSITE_SLUG = 'hosted-widget';
    const ONSITE_OWNER = 611;
    const ONSITE_REASON = 'ships an unreviewed third-party payload';

    const OFFSITE_ID = 'apl_offsite_target';
    const OFFSITE_SLUG = 'external-tool';
    const OFFSITE_OWNER = 722;
    const OFFSITE_REASON = 'destination page collects card details';

    const LOCKED_ID = 'apl_locked_target';
    const LOCKED_SLUG = 'self-pulled-widget';
    const LOCKED_OWNER = 833;
    const LOCKED_REASON = 'confirmed trademark impersonation';

    it('ON-SITE: notifies the owner with app-listing-hidden carrying the mod reason', async () => {
      mockRead.appListing.findUnique.mockResolvedValueOnce({
        ...onsiteListing('approved'),
        id: ONSITE_ID,
        slug: ONSITE_SLUG,
        name: 'Hosted Widget',
        userId: ONSITE_OWNER,
      });

      await delistListing({
        input: { appListingId: ONSITE_ID, reason: ONSITE_REASON },
        reviewerUserId: REVIEWER,
      });

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'app-listing-hidden',
          userId: ONSITE_OWNER,
          details: expect.objectContaining({
            slug: ONSITE_SLUG,
            name: 'Hosted Widget',
            listingId: ONSITE_ID,
            reason: ONSITE_REASON,
          }),
        })
      );
      // Same-event idempotency key, so a repeat of the SAME hide notifies once.
      const { key } = mockNotify.mock.calls[0][0];
      expect(key).toMatch(/^app-listing-hidden:/);
      // The key is bound to the audit event this delist wrote, not to a fresh nonce.
      expect(key).toBe(
        `app-listing-hidden:${mockWrite.appListingModerationEvent.create.mock.calls[0][0].data.id}`
      );
      // The backing block really was suspended in the same action (this is WHY the
      // on-site owner needs the notification).
      expect(mockWrite.appBlock.updateMany).toHaveBeenCalledWith({
        where: { id: BLOCK_ID, status: 'approved' },
        data: { status: 'suspended' },
      });
    });

    /**
     * 🔴 The pre-state is `removed`, NOT `approved` — this is the ENFORCED-TAKEDOWN
     * variant: the owner had self-unpublished, and this delist makes the last event a
     * mod takedown, which is what permanently forbids `republishOwnListing`. It is the
     * delist the owner most needs told about, and it is the case a status-gated notify
     * would silently skip while every `approved`-pre-state test stayed green.
     */
    it('ON-SITE, already REMOVED: the enforced-takedown delist still notifies the owner', async () => {
      mockRead.appListing.findUnique.mockResolvedValueOnce({
        ...onsiteListing('removed'),
        id: LOCKED_ID,
        slug: LOCKED_SLUG,
        name: 'Self Pulled Widget',
        userId: LOCKED_OWNER,
      });

      await delistListing({
        input: { appListingId: LOCKED_ID, reason: LOCKED_REASON },
        reviewerUserId: REVIEWER,
      });

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'app-listing-hidden',
          userId: LOCKED_OWNER,
          details: expect.objectContaining({
            slug: LOCKED_SLUG,
            name: 'Self Pulled Widget',
            listingId: LOCKED_ID,
            reason: LOCKED_REASON,
          }),
        })
      );
    });

    it('OFF-SITE: still notifies its own owner with its own reason (pinned, not dropped)', async () => {
      mockRead.appListing.findUnique.mockResolvedValueOnce({
        ...offsiteListing('approved'),
        id: OFFSITE_ID,
        slug: OFFSITE_SLUG,
        name: 'External Tool',
        userId: OFFSITE_OWNER,
      });

      await delistListing({
        input: { appListingId: OFFSITE_ID, reason: OFFSITE_REASON },
        reviewerUserId: REVIEWER,
      });

      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'app-listing-hidden',
          userId: OFFSITE_OWNER,
          details: expect.objectContaining({
            slug: OFFSITE_SLUG,
            name: 'External Tool',
            listingId: OFFSITE_ID,
            reason: OFFSITE_REASON,
          }),
        })
      );
      // No backing block on the off-site path.
      expect(mockWrite.appBlock.updateMany).not.toHaveBeenCalled();
    });

    it('a guarded (0-count) ON-SITE delist notifies NOBODY — the rollback covers the notification', async () => {
      mockRead.appListing.findUnique.mockResolvedValueOnce({
        ...onsiteListing('approved'),
        id: ONSITE_ID,
        slug: ONSITE_SLUG,
        userId: ONSITE_OWNER,
      });
      mockWrite.appListing.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        delistListing({
          input: { appListingId: ONSITE_ID, reason: ONSITE_REASON },
          reviewerUserId: REVIEWER,
        })
      ).rejects.toMatchObject({ name: 'OffsiteModerationError', code: 'NOT_TRANSITIONABLE' });

      expect(mockNotify).not.toHaveBeenCalled();
    });
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
// 🔴 Item 1 audit fix — the go-live scan-clean gate on relist / republish. A
// `removed` listing is still directly asset-editable (allow-pending attach), so
// relist/republish must refuse to make it live while any asset is pending/Blocked.
// The gate re-reads assets on the PRIMARY (tx) BEFORE the removed → approved flip.
// ---------------------------------------------------------------------------

const withAssets = <T extends object>(listing: T): T & { iconId: number; coverId: number } => ({
  ...listing,
  iconId: 1,
  coverId: 2,
});
const injectIngestion = (byId: Record<number, string>) =>
  (async (args: { where?: { id?: { in?: number[] } } }) =>
    (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: byId[id] ?? 'Scanned' }))) as never;

describe('relistListing / republishOwnListing — go-live ACTIONABILITY gate', () => {
  /** An off-site listing whose store CTA would have nothing to click. */
  const deadCta = (over: Record<string, unknown> = {}) => ({
    ...offsiteListing('removed'),
    externalUrl: null,
    ...over,
  });

  it('🔴 MOD relist REFUSES an off-site listing with no https destination — no flip, no event', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(deadCta());
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('needs a working link before it can go live'),
    });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 MOD relist REFUSES a CONNECT listing whose CTA is the dead stub (the shipped bug)', async () => {
    // The exact shape of the three listings that went live with a disabled
    // "Connecting this app will be available soon." button. Pre-#3585 the connect
    // arm is non-actionable regardless of the URL, so the gate refuses; post-#3585
    // a connect listing WITH an https URL becomes navigable and this case moves to
    // the allowed set — which is why the URL is null here, a shape that is
    // non-actionable under BOTH versions of the view-model.
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(
      deadCta({ connectClientId: 'client-123' })
    );
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('MOD relist ALLOWS an off-site listing with a valid https destination', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(offsiteListing('removed'));
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).resolves.toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalled();
  });

  it('MOD relist does NOT gate an ON-SITE listing (a model-slot app is legitimately non-navigable)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(onsiteListing('removed'));
    // No destination at all — an on-site listing never has one, and must still relist.
    mockWrite.appListing.findUnique.mockResolvedValue(onsiteListing('removed'));
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).resolves.toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalled();
  });

  it('🔴 OWNER republish REFUSES an off-site listing with no https destination — no flip', async () => {
    // The owner-driven half of the same hazard: a removed listing stays directly
    // editable, so an owner can clear the URL and then self-restore.
    mockWrite.appListing.findUnique.mockResolvedValue(deadCta());
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({
      action: 'owner-unpublish',
    });
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('needs a working link before it can go live'),
    });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });
});

describe('relistListing — go-live scan-clean gate', () => {
  it('REFUSES a listing whose icon is still scanning (no flip, no event)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(offsiteListing('removed')));
    mockWrite.image.findMany.mockImplementation(injectIngestion({ 1: 'Pending' }));
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('still scanning') });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('REFUSES a Blocked asset (no flip)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(offsiteListing('removed')));
    mockWrite.image.findMany.mockImplementation(injectIngestion({ 2: 'Blocked' }));
    await expect(
      relistListing({ input: { appListingId: APP_ID, reason: 'appeal upheld' }, reviewerUserId: REVIEWER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('blocked') });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('SUCCEEDS when every asset is Scanned (the normal relist path is unaffected)', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(offsiteListing('removed')));
    // Explicitly stage all-Scanned (clearAllMocks doesn't reset a prior test's
    // mockImplementation, so an empty injectIngestion map = every id Scanned).
    mockWrite.image.findMany.mockImplementation(injectIngestion({}));
    const res = await relistListing({
      input: { appListingId: APP_ID, reason: 'appeal upheld' },
      reviewerUserId: REVIEWER,
    });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
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

  // -------------------------------------------------------------------------
  // 🔴 SEAT REMEDIATION — new, and only necessary since seats became listing-keyed.
  // -------------------------------------------------------------------------

  /**
   * 🔴 WHY THIS EXISTS AT ALL. Before the block→listing re-key an OFF-SITE listing could
   * hold NO collaborator seats — `app_collaborators` was keyed on `app_blocks(id)` and an
   * off-site listing has no AppBlock — so "reassign `AppListing.userId`" WAS the complete
   * remediation and this gap did not exist. It does now.
   *
   * claim is the IMPERSONATION remedy (report → delist → claim → ban). Everything the
   * impersonator attached to the listing is part of what is being taken away. Left
   * behind, their seats survive as live editor capability on the REAL owner's listing,
   * their pending invites stay acceptable, their accepted-and-displayed seats keep
   * appearing in the PUBLIC BYLINE under the new owner's name, and a pending ownership
   * TRANSFER they had already offered stays acceptable — handing the listing straight
   * back out.
   */
  describe('🔴 claim clears the impersonator’s seats, invites and pending transfer', () => {
    /** Two seats: one accepted-and-displayed (the byline), one still pending. */
    const SEATS = [
      { userId: 901, status: 'accepted' },
      { userId: 902, status: 'pending' },
    ];

    function armClaim() {
      mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
      mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
    }

    it('POSITIVE CONTROL: with no seats and no transfer, nothing is deleted or cancelled', async () => {
      // The baseline. If this failed, every "was deleted" assertion below could be
      // satisfied by a fixture that deletes unconditionally.
      armClaim();
      await claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      });
      expect(mockWrite.appCollaborator.deleteMany).not.toHaveBeenCalled();
      expect(mockWrite.appOwnershipEvent.create).not.toHaveBeenCalled();
      // The transfer sweep is unconditional (a status-guarded updateMany is cheap and
      // cannot damage a terminal row), but it must record NOTHING when it matches none.
      expect(mockWrite.appOwnershipTransfer.updateMany).toHaveBeenCalledTimes(1);
    });

    it('🔴 every seat on the listing is DELETED — scoped to this listing', async () => {
      armClaim();
      mockWrite.appCollaborator.findMany.mockResolvedValue(SEATS);
      mockWrite.appCollaborator.deleteMany.mockResolvedValue({ count: 2 });
      await claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      });
      expect(mockWrite.appCollaborator.deleteMany).toHaveBeenCalledWith({
        where: { appListingId: APP_ID },
      });
      // 🔴 No `status` filter: a PENDING invite is exactly as much of the impersonator's
      // residue as an accepted seat, and leaving it would let them re-enter by having
      // their invitee simply accept afterwards.
      const where = mockWrite.appCollaborator.deleteMany.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('status');
    });

    it('🔴 each removed seat is AUDITED by user id — a count cannot name who lost access', async () => {
      armClaim();
      mockWrite.appCollaborator.findMany.mockResolvedValue(SEATS);
      mockWrite.appCollaborator.deleteMany.mockResolvedValue({ count: 2 });
      await claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      });
      const events = (
        mockWrite.appOwnershipEvent.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
      ).map((c) => c[0].data);
      expect(events).toHaveLength(2);
      expect(events.map((e) => e.targetUserId).sort()).toEqual([901, 902]);
      for (const e of events) {
        expect(e.action).toBe('remove');
        expect(e.actorUserId).toBe(REVIEWER);
        expect(e.appListingId).toBe(APP_ID);
        expect(e.slug).toBe(SLUG);
      }
      // The ids must be READ BEFORE the delete, or they cannot be recorded at all.
      expect(mockWrite.appCollaborator.findMany).toHaveBeenCalledWith({
        where: { appListingId: APP_ID },
        select: { userId: true, status: true },
      });
    });

    it('🔴 a PENDING ownership transfer is CANCELLED (guarded on pending) and audited', async () => {
      armClaim();
      mockWrite.appOwnershipTransfer.updateMany.mockResolvedValue({ count: 1 });
      await claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      });
      const call = mockWrite.appOwnershipTransfer.updateMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ appListingId: APP_ID, status: 'pending' });
      expect(call.data.status).toBe('cancelled');
      const events = (
        mockWrite.appOwnershipEvent.create.mock.calls as Array<[{ data: Record<string, unknown> }]>
      ).map((c) => c[0].data);
      expect(events).toHaveLength(1);
      expect(events[0].action).toBe('transfer_cancelled');
      expect(events[0].actorUserId).toBe(REVIEWER);
    });

    it('🔴 the cleanup happens INSIDE the claim transaction', async () => {
      // A cleanup issued outside the tx would survive a rolled-back claim — the listing
      // would keep its impersonating owner AND lose its seats. Same discipline the
      // "zero events on a guarded claim" tests already hold for the audit write.
      const order: string[] = [];
      mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
      mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
      mockWrite.appCollaborator.findMany.mockResolvedValue(SEATS);
      mockWrite.appCollaborator.deleteMany.mockImplementation(async () => {
        order.push('delete');
        return { count: 2 };
      });
      mockWrite.$transaction.mockImplementation(async (cb: (tx: WriteMock) => Promise<unknown>) => {
        order.push('tx:begin');
        const r = await cb(mockWrite);
        order.push('tx:commit');
        return r;
      });
      await claimListing({
        input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
        reviewerUserId: REVIEWER,
      });
      expect(order).toEqual(['tx:begin', 'delete', 'tx:commit']);
    });

    it('🔴 a GUARDED (0-row) claim deletes NOTHING — the rollback covers the seats too', async () => {
      // The reassign matches 0 rows (a concurrent action moved the listing), so the whole
      // tx throws before any cleanup. The seats belong to a listing that was not claimed.
      mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
      mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
      mockWrite.appListing.updateMany.mockResolvedValue({ count: 0 });
      mockWrite.appCollaborator.findMany.mockResolvedValue(SEATS);
      await expect(
        claimListing({
          input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
          reviewerUserId: REVIEWER,
        })
      ).rejects.toMatchObject({ code: 'NOT_TRANSITIONABLE' });
      expect(mockWrite.appCollaborator.deleteMany).not.toHaveBeenCalled();
      expect(mockWrite.appOwnershipTransfer.updateMany).not.toHaveBeenCalled();
    });

    /**
     * 🔴 THE PRE-MIGRATION WINDOW. These tables are manual-apply (DB rule #8). A
     * statement against a missing relation ABORTS the surrounding Postgres transaction
     * and no `catch` can undo that — every later statement fails 25P02 — so the
     * degrade-to-fallback CANNOT live inside the tx. It is a probe issued BEFORE one is
     * opened, and a missing table must leave the claim behaving exactly as it did before
     * this feature existed.
     */
    describe('the tables may not exist yet', () => {
      /** What Prisma raises for a missing relation. */
      const MISSING = Object.assign(new Error('relation "app_collaborators" does not exist'), {
        code: 'P2021',
      });

      it('🔴 a missing table SKIPS the remediation and the claim still succeeds', async () => {
        armClaim();
        mockRead.appCollaborator.count.mockRejectedValue(MISSING);
        const res = await claimListing({
          input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
          reviewerUserId: REVIEWER,
        });
        expect(res).toEqual({ appListingId: APP_ID, userId: TARGET });
        // Nothing collaborator-shaped is issued INSIDE the tx — which is the point: any
        // one of these would have aborted it.
        expect(mockWrite.appCollaborator.findMany).not.toHaveBeenCalled();
        expect(mockWrite.appCollaborator.deleteMany).not.toHaveBeenCalled();
        expect(mockWrite.appOwnershipTransfer.updateMany).not.toHaveBeenCalled();
        // …and the claim's own audit event is still written.
        expect(mockWrite.appListingModerationEvent.create).toHaveBeenCalledTimes(1);
      });

      it('🔴 the probe is issued BEFORE the transaction opens', async () => {
        // If it ran inside, the missing-table error would abort the tx and the `catch`
        // would be decorative — the whole reason it is out here.
        const order: string[] = [];
        mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
        mockWrite.appListing.findUnique.mockResolvedValueOnce(primarySnapshot('approved'));
        mockRead.appCollaborator.count.mockImplementation(async () => {
          order.push('probe');
          return 0;
        });
        mockWrite.$transaction.mockImplementation(
          async (cb: (tx: WriteMock) => Promise<unknown>) => {
            order.push('tx:begin');
            return cb(mockWrite);
          }
        );
        await claimListing({
          input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
          reviewerUserId: REVIEWER,
        });
        expect(order).toEqual(['probe', 'tx:begin']);
      });

      it('🔴 a NON-missing-table error still propagates — this is not a blanket swallow', async () => {
        // The degrade is narrow by design. A connection failure or a genuine query bug
        // must not be turned into "no seats to clean", which would silently skip the
        // remediation on every claim.
        //
        // 🔴 Only the REPLICA read is armed here, deliberately: this call throws at the
        // probe, BEFORE the transaction opens, so an `armClaim()` would leave an
        // unconsumed `mockResolvedValueOnce` on `mockWrite.appListing.findUnique`.
        // `vi.clearAllMocks()` clears recorded calls but NOT the once-queue, so that
        // value would be handed to the NEXT suite's first in-tx primary read — which is
        // how one leaked `Once` cascaded into 14 unrelated failures while this file was
        // being written.
        mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('approved'));
        mockRead.appCollaborator.count.mockRejectedValue(new Error('connection reset'));
        await expect(
          claimListing({
            input: { appListingId: APP_ID, targetUserId: TARGET, reason: GOOD_REASON },
            reviewerUserId: REVIEWER,
          })
        ).rejects.toThrow('connection reset');
      });
    });
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
    // `externalUrl` present for the same reason as `offsiteListing` above: republish
    // is a go-live and runs the off-site actionability gate.
    return {
      userId,
      status,
      kind,
      slug: SLUG,
      name: 'Cool App',
      appBlockId,
      externalUrl: kind === 'offsite' ? EXTERNAL_URL : null,
      connectClientId: null,
    };
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
    // `externalUrl` present for the same reason as `offsiteListing` above: republish
    // is a go-live and runs the off-site actionability gate.
    return {
      userId,
      status,
      kind,
      slug: SLUG,
      name: 'Cool App',
      appBlockId,
      externalUrl: kind === 'offsite' ? EXTERNAL_URL : null,
      connectClientId: null,
    };
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

  // 🔴 Item 1 audit fix — the go-live scan-clean gate on the OWNER republish path
  // (the primary exploit: owner-unpublish leaves iconId/coverId set + the removed
  // listing stays directly asset-editable, so an owner could attach a still-scanning
  // / later-Blocked image then self-restore). Runs AFTER the last-event guard, BEFORE
  // the flip.
  it('go-live scan gate: REFUSES republish when an asset is still scanning (no flip)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(ownerPrimary('removed')));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    mockWrite.image.findMany.mockImplementation(injectIngestion({ 1: 'Pending' }));
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('still scanning') });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('go-live scan gate: REFUSES republish when an asset was Blocked (no flip)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(ownerPrimary('removed')));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    mockWrite.image.findMany.mockImplementation(injectIngestion({ 2: 'Blocked' }));
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('blocked') });
    expect(mockWrite.appListing.updateMany).not.toHaveBeenCalled();
  });

  it('go-live scan gate: SUCCEEDS when every asset is Scanned (normal republish unaffected)', async () => {
    mockWrite.appListing.findUnique.mockResolvedValue(withAssets(ownerPrimary('removed')));
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({ action: 'owner-unpublish' });
    // Explicitly stage all-Scanned (clearAllMocks doesn't reset a prior test's impl).
    mockWrite.image.findMany.mockImplementation(injectIngestion({}));
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListing.updateMany).toHaveBeenCalledWith({
      where: { id: APP_ID, kind: 'offsite', status: 'removed' },
      data: { status: 'approved' },
    });
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

// ---------------------------------------------------------------------------
// 🔴 republishOwnListing — GO-LIVE MATURITY GATE (kind-aware).
//
// The hole this closes: republish is an OWNER-driven go-live with NO human in the
// loop, and a `removed` listing is directly asset-editable. The attach path rejects
// only `Blocked`/`NotFound` images, never a `Scanned` MATURE one, and neither
// pre-existing gate inspects maturity — so `unpublish → attach mature media →
// republish` put mature store art back under an unchanged declared rating, which
// passes `listingMatureFilter(redCapable=false)` (`content_rating NOT IN ('r','x')`).
//
// KIND-AWARE by design:
//   OFF-SITE → RAISE the stored rating to the media-derived one (raise-only).
//   ON-SITE  → do NOT raise (the rating mirrors `AppBlock.content_rating`); allow the
//              republish and queue an advisory `AppListingReport` for a moderator.
//
// 🔴 COVERAGE HONESTY. Of the 15 cases below, SEVEN are RED at `origin/main` and green
// at HEAD — those are the regression coverage:
//   off-site ABOVE · on-site ABOVE (+ its CHECK-set case) · screenshots-contribute ·
//   idempotence · fail-closed · transactional.
// The other EIGHT are green at `origin/main` too and are labelled `[INVARIANT GUARD]`:
// they pin behaviour this change must NOT alter (raise-only never lowers, no-assets,
// absent row, the pre-existing scan gate, the mod relist path). They are preservation
// guards and are deliberately NOT counted as regression coverage.
//
// Levels are the REAL enum (`src/server/common/enums.ts`): PG=1, PG13=2, R=4, X=8.
// The ladder is `['g','pg','pg13','r','x']`; `deriveContentRatingFromAssets` picks the
// minimal rating covering the MAX asset level, so R(4)→'r' and X(8)→'x' — those are
// exactly the two values `listingMatureFilter` hides, which is why the fixtures use
// them rather than the level-2 art that happens to be live today.
// ---------------------------------------------------------------------------
describe('republishOwnListing — go-live MATURITY gate (kind-aware)', () => {
  /** Pairwise-distinct asset ids, so a wrong-bind mutant cannot alias two of them. */
  const ICON_ID = 101;
  const COVER_ID = 202;
  const SHOT_ID = 303;
  /** Real `NsfwLevel` members — not magic numbers. */
  const LVL_PG = 1;
  const LVL_PG13 = 2;
  const LVL_R = 4;
  const LVL_X = 8;

  function ownerPrimary(opts: {
    kind: string;
    contentRating: string | null;
    appBlockId?: string | null;
  }) {
    return {
      userId: OWNER,
      status: 'removed',
      kind: opts.kind,
      slug: SLUG,
      name: 'Cool App',
      appBlockId: opts.appBlockId ?? (opts.kind === 'onsite' ? BLOCK_ID : null),
      contentRating: opts.contentRating,
      externalUrl: opts.kind === 'offsite' ? EXTERNAL_URL : null,
      connectClientId: null,
    };
  }

  /**
   * Wire the three `appListing.findUnique` reads republish performs, in order:
   *   1. `loadOwnedListingInTx`      → the owned-listing snapshot (with contentRating)
   *   2. `assertListingAssetsScanCleanInTx` → the asset ids for the scan gate
   *   3. `resolveListingRatingFloorInTx`    → the asset ids for the maturity derive
   * plus the screenshot + image reads BOTH (2) and (3) share.
   *
   * `levels` maps image id → nsfwLevel; every image also carries `ingestion` so the
   * pre-existing scan gate is satisfied and the maturity code is REACHABLE (an input
   * no earlier check rejects).
   */
  function wire(opts: {
    kind: string;
    contentRating: string | null;
    icon?: number | null;
    cover?: number | null;
    shots?: number[];
    levels?: Record<number, number>;
    ingestion?: string;
  }) {
    const icon = opts.icon === undefined ? ICON_ID : opts.icon;
    const cover = opts.cover === undefined ? COVER_ID : opts.cover;
    const shots = opts.shots ?? [SHOT_ID];
    const levels = opts.levels ?? {};
    const ingestion = opts.ingestion ?? 'Scanned';

    // 🔴 Re-established on EVERY wire(), not left to `beforeEach`: `vi.clearAllMocks()`
    // clears call history but NOT implementations, so a `mockResolvedValue` set by an
    // earlier test leaks forward. That leak silently disarmed the transactional test
    // (the idempotence test's "an open review exists" stub made the queue write a
    // no-op, so nothing could throw) — a green-for-the-wrong-reason, caught only
    // because the assertion happened to be a rejection.
    mockWrite.appListingReport.findFirst.mockResolvedValue(null);
    mockWrite.appListingReport.create.mockImplementation(async (a: { data: unknown }) => a.data);
    mockWrite.appListing.findUnique.mockResolvedValue({ iconId: icon, coverId: cover });
    mockWrite.appListing.findUnique.mockResolvedValueOnce(
      ownerPrimary({ kind: opts.kind, contentRating: opts.contentRating })
    );
    mockWrite.appListingScreenshot.findMany.mockResolvedValue(shots.map((imageId) => ({ imageId })));
    mockWrite.image.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion, nsfwLevel: levels[id] ?? 0 }))
    );
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({
      action: 'owner-unpublish',
    });
  }

  /** The `data` payload of the listing status flip. */
  function flipData() {
    const call = mockWrite.appListing.updateMany.mock.calls.find(
      (c: [{ where?: { status?: string } }]) => c[0]?.where?.status === 'removed'
    );
    return call?.[0]?.data;
  }

  // ---- OFF-SITE × media-vs-declared -------------------------------------------------

  it('[INVARIANT GUARD — green at origin/main] OFF-SITE, media BELOW declared → rating UNCHANGED (raise-only never lowers)', async () => {
    // Max asset level R(4) → derived 'r'; declared 'x' (level 8) is HIGHER, so a
    // raise-only floor must leave it alone. A lower-vs-raise inversion mutant would
    // write 'r' here and lose a deliberately mature rating.
    wire({
      kind: 'offsite',
      contentRating: 'x',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_R, [SHOT_ID]: LVL_PG },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(flipData()).toEqual({ status: 'approved' });
    expect(flipData()).not.toHaveProperty('contentRating');
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });

  it('[INVARIANT GUARD — green at origin/main] OFF-SITE, media EQUAL to declared → rating UNCHANGED (no needless write)', async () => {
    // Max R(4) → derived 'r' === declared 'r'. Strict-inequality boundary: a `>` → `>=`
    // mutant in the floor would still produce 'r', but the ABOVE case below pins the
    // raise, and this pins that EQUAL does not emit a contentRating key at all.
    wire({
      kind: 'offsite',
      contentRating: 'r',
      levels: { [ICON_ID]: LVL_PG, [COVER_ID]: LVL_R, [SHOT_ID]: LVL_PG13 },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(flipData()).toEqual({ status: 'approved' });
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });

  it('🔴 OFF-SITE, media ABOVE declared → rating RAISED to the derived value', async () => {
    // THE DEFECT. Declared 'g' with X(8) cover art: pre-fix this went live as 'g' and
    // `content_rating NOT IN ('r','x')` showed it to SFW-only users.
    wire({
      kind: 'offsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'x' });
    // Off-site is fixed by the raise alone — it must NOT also spend a moderator slot.
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });

  // ---- ON-SITE × media-vs-declared --------------------------------------------------

  it('[INVARIANT GUARD — green at origin/main] ON-SITE, media BELOW declared → republishes normally, rating untouched, NO queue entry', async () => {
    wire({
      kind: 'onsite',
      contentRating: 'x',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_R, [SHOT_ID]: LVL_PG },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(flipData()).toEqual({ status: 'approved' });
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
    // The backing block is still restored — the maturity gate must not disturb that.
    expect(mockWrite.appBlock.updateMany).toHaveBeenCalled();
  });

  it('[INVARIANT GUARD — green at origin/main] ON-SITE, media EQUAL to declared → republishes normally, NO queue entry', async () => {
    wire({
      kind: 'onsite',
      contentRating: 'r',
      levels: { [ICON_ID]: LVL_PG, [COVER_ID]: LVL_R, [SHOT_ID]: LVL_PG13 },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(flipData()).toEqual({ status: 'approved' });
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });

  it('🔴 ON-SITE, media ABOVE declared → stored rating UNCHANGED (manifest mirror) + queue entry created', async () => {
    // The kind-aware half. An on-site listing's rating mirrors AppBlock.content_rating,
    // so it is deliberately NOT auto-raised — a kind-branch-inversion mutant would
    // write contentRating here and break the manifest-mirror invariant.
    wire({
      kind: 'onsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    // INVARIANT: the rating is NOT raised.
    expect(flipData()).toEqual({ status: 'approved' });
    expect(flipData()).not.toHaveProperty('contentRating');
    // ...and a moderator IS queued.
    expect(mockWrite.appListingReport.create).toHaveBeenCalledTimes(1);
    const queued = mockWrite.appListingReport.create.mock.calls[0][0].data;
    expect(queued).toMatchObject({
      appListingId: APP_ID,
      reporterUserId: OWNER,
      reason: 'inappropriate',
      status: 'pending',
    });
    // The details string names the DERIVED rating first and the DECLARED second — a
    // wrong-bind mutant that swaps them produces a plausible sentence, so pin both
    // fragments positionally rather than merely asserting the two words appear.
    expect(queued.details).toContain('media rated "x"');
    expect(queued.details).toContain('declared content rating of "g"');
  });

  it('ON-SITE over-rated: the queue reason is a member of the CHECK-constrained reason set', async () => {
    // A value outside the DB CHECK (impersonation|phishing-malware|broken|
    // inappropriate|spam|other) would be rejected at 23514 in production, where the
    // mock happily accepts anything.
    wire({
      kind: 'onsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_PG13 },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    const queued = mockWrite.appListingReport.create.mock.calls[0][0].data;
    expect(APP_LISTING_REPORT_REASONS as readonly string[]).toContain(queued.reason);
    expect(['pending', 'resolved', 'dismissed']).toContain(queued.status);
  });

  // ---- Edge cases -------------------------------------------------------------------

  it('[INVARIANT GUARD — green at origin/main] listing with NO attached assets → rating unchanged, no queue entry, no crash', async () => {
    wire({ kind: 'offsite', contentRating: 'g', icon: null, cover: null, shots: [] });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(flipData()).toEqual({ status: 'approved' });
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });

  it('[INVARIANT GUARD — green at origin/main] absent listing row on the FLOOR read → declared rating preserved, republish still succeeds', async () => {
    // The floor helper returns `declaredRating` when its own findUnique misses (a race
    // with a concurrent purge). Pre-existing behaviour must survive.
    mockWrite.appListing.findUnique.mockResolvedValue(null);
    mockWrite.appListing.findUnique.mockResolvedValueOnce(
      ownerPrimary({ kind: 'offsite', contentRating: 'pg13' })
    );
    mockWrite.appListingModerationEvent.findFirst.mockResolvedValueOnce({
      action: 'owner-unpublish',
    });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(flipData()).toEqual({ status: 'approved' });
  });

  it('🔴 SCREENSHOTS contribute to the derived max, not just icon/cover', async () => {
    // Icon and cover are both tame; the ONLY mature asset is a screenshot. A mutant
    // that derives from `[iconId, coverId]` and drops the screenshot spread survives
    // every icon/cover-driven case above and dies here.
    wire({
      kind: 'offsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG, [COVER_ID]: LVL_PG, [SHOT_ID]: LVL_X },
    });
    await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    expect(flipData()).toEqual({ status: 'approved', contentRating: 'x' });
  });

  it('IDEMPOTENCE: a repeat republish with an OPEN review does NOT create a duplicate queue entry', async () => {
    wire({
      kind: 'onsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
    });
    // An open advisory review already exists for this listing+reporter — mirroring the
    // DB's partial-unique `(app_listing_id, reporter_user_id) WHERE status='pending'`.
    mockWrite.appListingReport.findFirst.mockResolvedValue({ id: 'alrp_existing' });
    const res = await republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER });
    // The republish still succeeds — an existing review must never block the owner.
    expect(res).toEqual({ appListingId: APP_ID, status: 'approved' });
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
    // The dedup probe is scoped to pending + this listing + this reporter.
    expect(mockWrite.appListingReport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { appListingId: APP_ID, reporterUserId: OWNER, status: 'pending' },
      })
    );
  });

  it('[INVARIANT GUARD — green at origin/main] 🔴 a BLOCKED asset still refuses via the PRE-EXISTING scan gate (the new code did not displace it)', async () => {
    // Reachability/attribution: the media is also over-rated (X), so BOTH gates would
    // have something to say. The scan gate runs FIRST, so the listing must not flip and
    // no queue entry may be written — proving the maturity code did not take over.
    wire({
      kind: 'onsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
      ingestion: 'Blocked',
    });
    // ATTRIBUTION: assert the SCAN gate's own error, not merely "something threw" —
    // otherwise this passes just as well if the maturity code throws first, which is
    // the exact displacement it is meant to rule out.
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('blocked'),
    });
    expect(flipData()).toBeUndefined();
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 FAIL-CLOSED: a throwing rating derivation leaves the listing NOT live', async () => {
    wire({
      kind: 'offsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
    });
    // First image.findMany (the scan gate) succeeds; the SECOND (the maturity derive)
    // throws — so the failure is attributable to the derive, not the scan gate.
    let call = 0;
    mockWrite.image.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: number[] } } }) => {
        if (++call >= 2) throw new Error('nsfwLevel read failed');
        return (args?.where?.id?.in ?? []).map((id) => ({ id, ingestion: 'Scanned', nsfwLevel: 0 }));
      }
    );
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toThrow('nsfwLevel read failed');
    // NOT live, and no audit event claiming it was.
    expect(flipData()).toBeUndefined();
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  it('🔴 TRANSACTIONAL: a failing queue write aborts the whole republish (nothing half-committed)', async () => {
    wire({
      kind: 'onsite',
      contentRating: 'g',
      levels: { [ICON_ID]: LVL_PG13, [COVER_ID]: LVL_X, [SHOT_ID]: LVL_R },
    });
    mockWrite.appListingReport.create.mockRejectedValueOnce(new Error('queue write failed'));
    await expect(
      republishOwnListing({ input: { appListingId: APP_ID }, userId: OWNER })
    ).rejects.toThrow('queue write failed');
    // The queue write is INSIDE the tx callback, so the error escapes $transaction and
    // the status flip rolls back with it. The audit event (written after the queue)
    // never happens — if it did, the two would be able to disagree.
    expect(mockWrite.appListingModerationEvent.create).not.toHaveBeenCalled();
  });

  // ---- Regression: the sibling flips are untouched -----------------------------------

  it('[INVARIANT GUARD — green at origin/main] relistListing (mod, human in the loop) applies NO floor and queues NOTHING', async () => {
    mockRead.appListing.findUnique.mockResolvedValueOnce(offsiteListing('removed'));
    mockWrite.appListing.findUnique.mockResolvedValue({ iconId: ICON_ID, coverId: COVER_ID });
    mockWrite.appListingScreenshot.findMany.mockResolvedValue([{ imageId: SHOT_ID }]);
    // Deliberately over-rated media — the mod path must still not auto-raise or queue.
    mockWrite.image.findMany.mockImplementation(
      async (args: { where?: { id?: { in?: number[] } } }) =>
        (args?.where?.id?.in ?? []).map((id) => ({
          id,
          ingestion: 'Scanned',
          nsfwLevel: id === COVER_ID ? LVL_X : LVL_PG,
        }))
    );
    await relistListing({
      input: { appListingId: APP_ID, reason: GOOD_REASON },
      userId: REVIEWER,
    });
    const relistCall = mockWrite.appListing.updateMany.mock.calls.find(
      (c: [{ data?: Record<string, unknown> }]) => c[0]?.data?.status === 'approved'
    );
    expect(relistCall?.[0]?.data).not.toHaveProperty('contentRating');
    expect(mockWrite.appListingReport.create).not.toHaveBeenCalled();
  });
});
