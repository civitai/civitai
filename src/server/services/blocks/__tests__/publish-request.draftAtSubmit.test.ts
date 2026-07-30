import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * W13 draft-at-submit — REJECT / WITHDRAW cleanup of the pre-approval on-site DRAFT
 * `AppListing`.
 *
 * On reject or withdraw of a first-version on-site publish request, the draft listing
 * minted at submit must be DELETED (release the slug + drop unreviewed media),
 * mirroring the off-site `closeTerminalListing` draft branch: a status-guarded
 * `deleteMany({ status:'draft' })` — the DB FKs then cascade `AppListingScreenshot`
 * and SetNull the `Image` rows (verified structurally, not in this mock). Resolved BY
 * SLUG (the on-site request has no appListingId FK). A subsequent-version / legacy
 * pre-ship request has no such draft → the `deleteMany` is a harmless 0-row no-op.
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
  db.write.appBlockPublishRequest.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
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

describe('rejectRequest — deletes the pre-approval draft (status-guarded, by slug)', () => {
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

  it('flips the request → rejected AND deletes the on-site draft for the slug (cascade screenshots, SetNull images)', async () => {
    await rejectRequest({
      publishRequestId: 'req_1',
      reviewerUserId: 9,
      rejectionReason: 'not good enough for production',
    });

    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'rejected' }) })
    );
    const deletes = draftDeleteCalls();
    expect(deletes).toHaveLength(1);
    // Status-guarded delete (can never remove an approved/removed row).
    expect(deletes[0][0]).toEqual({
      where: { slug: SLUG, kind: 'onsite', appBlockId: null, status: 'draft' },
    });
  });

  it('reject STANDS even if the draft cleanup throws (best-effort)', async () => {
    db.write.appListing.deleteMany.mockRejectedValueOnce(new Error('db blip'));
    await expect(
      rejectRequest({
        publishRequestId: 'req_1',
        reviewerUserId: 9,
        rejectionReason: 'not good enough for production',
      })
    ).resolves.toBeUndefined();
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalled();
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
