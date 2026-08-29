import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 draft-at-submit — what REJECT and WITHDRAW each do to the pre-approval on-site
 * DRAFT `AppListing`, and the fact that they DISAGREE.
 *
 * WITHDRAW deletes it (release the slug + drop unreviewed media), mirroring the off-site
 * `closeTerminalListing` draft branch: a status-guarded `deleteMany({ status:'draft' })`
 * — the DB FKs then cascade `AppListingScreenshot` and SetNull the `Image` rows (verified
 * structurally, not in this mock). Resolved BY SLUG (the on-site request has no
 * appListingId FK). A subsequent-version / legacy pre-ship request has no such draft → the
 * `deleteMany` is a harmless 0-row no-op.
 *
 * REJECT does NOT — see the 🔴 block above that describe (clawgate #302). The deliberate,
 * mod-initiated version of that delete now lives in `purgeListing`'s on-site orphan-draft
 * arm (`offsite-moderation.service.ts`), covered by
 * `offsite-moderation.service.purge-onsite-draft.test.ts`.
 *
 * DB fully mocked — only the reads/writes reject/withdraw make are stubbed.
 */

const { db } = vi.hoisted(() => {
  const make = () => ({
    appBlockPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appListing: {
      // reset-listing probe (closeOnsiteResetListingOnWithdraw) — null = not a reset.
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // the draft cleanup.
      deleteMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
      // Not used by either path today — stubbed so the reject block can assert the
      // ABSENCE of a status flip (e.g. draft → removed) as well as of a delete.
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    appReviewAgentReport: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    $transaction: vi.fn(async (fn: unknown) =>
      typeof fn === 'function' ? (fn as (tx: unknown) => unknown)(db.write) : undefined
    ),
  });
  const db = { read: make(), write: make() };
  return { db };
});

vi.mock('~/server/db/client', () => ({ dbRead: db.read, dbWrite: db.write }));
vi.mock('~/env/server', () => ({
  env: { APPS_DOMAIN: 'apps.example', NEXTAUTH_URL: 'https://civitai.example' },
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => ({ send: vi.fn(async () => ({})) }),
  bundleKey: (sha: string) => `bundles/${sha}.zip`,
  deleteStagedBundle: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  ensureReviewRepo: vi.fn(async () => undefined),
  commitFiles: vi.fn(async () => ({ sha: 'x' })),
}));
vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
}));

const { rejectRequest, withdrawRequest } = await import(
  '~/server/services/blocks/publish-request.service'
);

const SLUG = 'cool-app';
const SUBMITTER = 4242;

beforeEach(() => {
  vi.clearAllMocks();
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appListing.deleteMany.mockResolvedValue({ count: 1 });
  db.read.appListing.findFirst.mockResolvedValue(null);
  db.write.appReviewAgentReport.findFirst.mockResolvedValue(null);
});

/** The scoped draft-delete call (ignores any unrelated appListing writes). */
function draftDeleteCalls() {
  return db.write.appListing.deleteMany.mock.calls.filter((c) => {
    const w = (c[0] as { where?: Record<string, unknown> })?.where ?? {};
    return w.kind === 'onsite' && w.status === 'draft' && w.appBlockId === null;
  });
}

/**
 * 🔴 REGRESSION — clawgate #302 / ClickUp 868kuam02.
 *
 * `rejectRequest` USED to call `deleteOnsiteDraftListingForSlug`. That made a
 * first-version reject destructive in a way no reviewer could see or decline: rejecting a
 * first-time developer over a fixable problem (the reported case was a missing screenshot)
 * hard-deleted the store listing they had built AND released their slug. Reject is the only
 * "please fix this" signal the review path has — there is no `changes-requested` outcome —
 * so the destructive branch fired precisely on the cases it should not have.
 *
 * These tests are RED on the pre-change code: it deleted, so every "no delete" assertion
 * below fails there.
 *
 * The invariant is a RELATIONSHIP, not a property of one function — reject and withdraw
 * must DISAGREE. Withdraw is the developer abandoning their own submission (releasing the
 * slug is what they asked for); reject is a moderator verdict on a submission the developer
 * still wants. The `withdrawRequest` block below is the other half of this guard, and a
 * mutant that restores the delete in `rejectRequest` is caught here while leaving it green.
 */
describe('rejectRequest — KEEPS the pre-approval draft (clawgate #302)', () => {
  beforeEach(() => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'req_1',
      status: 'pending',
      deployState: null,
      slug: SLUG,
      version: '0.1.0',
      manifest: { name: 'Cool App' },
      submittedByUserId: SUBMITTER,
    });
  });

  it('flips the request → rejected WITHOUT deleting the on-site draft for the slug', async () => {
    await rejectRequest({
      publishRequestId: 'req_1',
      reviewerUserId: 9,
      rejectionReason: 'not good enough for production',
    });

    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) })
    );
    expect(draftDeleteCalls()).toHaveLength(0);
  });

  /**
   * Deliberately WIDER than `draftDeleteCalls()`. That helper matches the exact old
   * predicate, so a mutant that restores the delete with any OTHER shape — a different
   * `where`, a `delete` instead of `deleteMany` — would walk straight through it. This
   * asserts the reject path performs NO destructive `AppListing` write at all, which is
   * the claim that actually protects the developer's listing.
   */
  it('performs NO AppListing delete of any shape', async () => {
    await rejectRequest({
      publishRequestId: 'req_1',
      reviewerUserId: 9,
      rejectionReason: 'not good enough for production',
    });
    expect(db.write.appListing.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * The slug must still be RESERVED after the reject — that is the half a "we stopped
   * deleting" test cannot see on its own. Nothing in the reject path may release it, so
   * the developer's chosen slug is still theirs when they fix the problem and re-submit
   * (`submitVersion` then REUSES the surviving draft, owner-scoped).
   */
  it('leaves the listing row — and therefore the slug — untouched', async () => {
    await rejectRequest({
      publishRequestId: 'req_1',
      reviewerUserId: 9,
      rejectionReason: 'missing a screenshot',
    });
    expect(db.write.appListing.deleteMany).not.toHaveBeenCalled();
    expect(db.write.appListing.updateMany).not.toHaveBeenCalled();
  });
});

describe('withdrawRequest — deletes the pre-approval draft (first-version)', () => {
  beforeEach(() => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'req_1',
      status: 'pending',
      submittedByUserId: SUBMITTER,
      deployState: null,
      slug: SLUG,
    });
  });

  it('flips the request → withdrawn AND deletes the on-site draft for the slug', async () => {
    await withdrawRequest({ publishRequestId: 'req_1', userId: SUBMITTER });

    expect(db.write.appBlockPublishRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'req_1', status: 'pending' },
        data: { status: 'withdrawn' },
      })
    );
    const deletes = draftDeleteCalls();
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toEqual({
      where: { slug: SLUG, kind: 'onsite', appBlockId: null, status: 'draft' },
    });
  });

  it('withdraw STANDS even if the draft cleanup throws (best-effort)', async () => {
    db.write.appListing.deleteMany.mockRejectedValueOnce(new Error('db blip'));
    await expect(
      withdrawRequest({ publishRequestId: 'req_1', userId: SUBMITTER })
    ).resolves.toBeUndefined();
    expect(db.write.appBlockPublishRequest.updateMany).toHaveBeenCalled();
  });

  it('an already-withdrawn request is an idempotent no-op — no draft delete', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      id: 'req_1',
      status: 'withdrawn',
      submittedByUserId: SUBMITTER,
      deployState: null,
      slug: SLUG,
    });
    await withdrawRequest({ publishRequestId: 'req_1', userId: SUBMITTER });
    expect(draftDeleteCalls()).toHaveLength(0);
  });
});
