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

/**
 * The client-claimed source commit on the approved row being cloned. Distinct
 * from `forgejoCommitSha` below in every character, so an assertion cannot pass
 * by the two being confused for one another.
 */
const SOURCE_SHA = '4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3';

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
  // #4059 client-claimed provenance on the approved row.
  sourceCommit: SOURCE_SHA,
  sourceDirty: true,
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

  /**
   * #4059 — the clone must CARRY the client-claimed provenance forward.
   *
   * The justification is narrow and it is the only one: this clone re-submits a
   * BYTE-IDENTICAL bundle (same `bundleKey`, same `bundleSha256`) that the
   * approved row already carried. A claim about where those exact bytes came
   * from is still the SAME claim about the SAME bytes — carrying it is not
   * inventing anything. Dropping it, by contrast, permanently loses the answer
   * to "which tree did these bytes come from?" for any app that goes through a
   * suspend → reset-to-pending cycle, which is exactly the archaeology #4059
   * exists to make unnecessary.
   *
   * 🔴 This is NOT the `recordPendingFromPush` case, which correctly leaves both
   * NULL: that path has no client and no author work tree, so there is no claim
   * to carry. Here there is one, and it is already attached to these bytes.
   */
  describe('#4059 provenance carry-forward', () => {
    it('SELECTS both provenance columns on the latest-approved read', async () => {
      await resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'needs another look' },
        reviewerUserId: MOD,
      });
      // Call 0 is the latest-approved lookup (call 1 is the open-pending probe).
      const select = mockRead.appBlockPublishRequest.findFirst.mock.calls[0][0].select;
      expect(select).toMatchObject({ sourceCommit: true, sourceDirty: true });
    });

    it('CARRIES sourceCommit + sourceDirty onto the cloned pending request', async () => {
      await resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'needs another look' },
        reviewerUserId: MOD,
      });
      const reqArg = mockWrite.appBlockPublishRequest.create.mock.calls[0][0].data;
      expect(reqArg.sourceCommit).toBe('4f3a9c2e17b06d85fa1c39e470b28d6ac519e0f3');
      expect(reqArg.sourceDirty).toBe(true);
      // And it is the AUTHOR'S claim, not the platform's Forgejo sha — the two
      // travel together on this row and must never be aliased.
      expect(reqArg.forgejoCommitSha).toBe('sha_abc');
      expect(reqArg.sourceCommit).not.toBe(reqArg.forgejoCommitSha);
      // The bytes are what licenses the carry-forward; assert they really are
      // the same bytes, so this test fails loudly if the clone ever stops being
      // byte-identical while still copying the claim.
      expect(reqArg.bundleKey).toBe('bundles/deadbeef.zip');
      expect(reqArg.bundleSha256).toBe('deadbeef');
    });

    it('CARRIES sourceDirty:false as FALSE (a CLAIM of clean, not an absence)', async () => {
      mockRead.appBlockPublishRequest.findFirst
        .mockReset()
        .mockResolvedValueOnce({ ...lastApprovedReq, sourceDirty: false })
        .mockResolvedValueOnce(null);
      await resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'needs another look' },
        reviewerUserId: MOD,
      });
      const reqArg = mockWrite.appBlockPublishRequest.create.mock.calls[0][0].data;
      // `toBe(false)`, not a falsy check: null/undefined would pass a falsy
      // check and mean UNKNOWN, the opposite answer.
      expect(reqArg.sourceDirty).toBe(false);
      expect(reqArg.sourceDirty).not.toBeNull();
      expect(reqArg.sourceDirty).not.toBeUndefined();
    });

    // 🔴 INVARIANT GUARD, NOT REGRESSION COVERAGE — this one was measured GREEN
    // against the pre-carry-forward service, because a path that writes neither
    // column trivially satisfies "neither column was invented". It earns its
    // place against the FALLBACK mutants (`?? forgejoCommitSha`, `?? false`),
    // which it does kill; do not count it as coverage for the drop this
    // describe-block fixes — the three siblings above are that.
    it('does NOT INVENT a value when the approved row has NULLs (unknown stays unknown)', async () => {
      mockRead.appBlockPublishRequest.findFirst
        .mockReset()
        .mockResolvedValueOnce({ ...lastApprovedReq, sourceCommit: null, sourceDirty: null })
        .mockResolvedValueOnce(null);
      await resetOnsiteListingToPending({
        input: { appListingId: 'apl_1', reason: 'needs another look' },
        reviewerUserId: MOD,
      });
      const reqArg = mockWrite.appBlockPublishRequest.create.mock.calls[0][0].data;
      expect(reqArg.sourceCommit ?? null).toBeNull();
      expect(reqArg.sourceDirty ?? null).toBeNull();
      // 🔴 And specifically NOT fallen back to the Forgejo sha, which IS present
      // on this row — the one substitution that would look plausible and be a
      // fabricated claim about an author's tree.
      expect(reqArg.forgejoCommitSha).toBe('sha_abc');
      expect(reqArg.sourceCommit).not.toBe('sha_abc');
      // Nor coerced to the `false` claim.
      expect(reqArg.sourceDirty).not.toBe(false);
    });
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
