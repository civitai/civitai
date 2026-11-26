import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
// Publish paths here run as a developer who accepted the App Developer Terms; a test that needs the
// refusal overrides the stub.
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

/**
 * On-site App Block submitter-notification SERVICE emission tests.
 *
 * Mirrors the off-site emission tests (offsite-listing.service.test.ts):
 * `approveRequest` / `rejectRequest` are exercised with their DB + heavy deps mocked,
 * and the emit helper `~/server/services/blocks/app-block-notify` is mocked so we can
 * assert the POST-COMMIT call WITHOUT pulling the notifications client graph.
 *
 * The four guarantees under test:
 *   1. approve emits `app-block-approved` to `submittedByUserId` (right key + details),
 *   2. reject emits `app-block-rejected` with the trimmed reason,
 *   3. BEST-EFFORT — a notify failure is swallowed; the approve/reject still succeeds,
 *   4. POST-COMMIT ordering — a FAILED approve/reject emits nothing.
 */

const { mockNotify, db, s3, holder } = vi.hoisted(() => {
  const mockNotify = vi.fn(async (..._a: unknown[]) => undefined);
  const holder: { zipBytes: Uint8Array } = { zipBytes: new Uint8Array() };
  const makeDb = () => ({
    // `approveRequest`'s pre-flight probes the media-split table; no row reads as absent.
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    // The storage-migration approve gate (`reserveStorageMigrationRuns`): no open run.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        $executeRawUnsafe: async () => 0,
      })
    ),
    appBlockPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // The previous approved version (`getPreviousApprovedState`): none.
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      // The storage-migration history (`loadStorageMigrationBaseline`): none.
      findMany: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 1 })),
    },
    appBlock: {
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 'apb_existing' })),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
    oauthClient: {
      // Only the late-hold ceiling read (select: allowedScopes) finds the client.
      findUnique: vi.fn(
        async (...a: unknown[]): Promise<unknown> =>
          (a[0] as { select?: { allowedScopes?: boolean } } | undefined)?.select?.allowedScopes
            ? { allowedScopes: 0n }
            : null
      ),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
    },
    appListing: {
      findUnique: vi.fn(
        async (..._a: unknown[]): Promise<unknown> => ({ id: 'apl_existing', kind: 'onsite' })
      ),
      // approveRequest's up-front "which listing does this approve publish" read (the
      // publish floor): no draft / reset listing here, so nothing is gated.
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
  });
  const db = { read: makeDb(), write: makeDb() };
  // approveRequest's final step runs in a transaction that writes the request and the block.
  db.write.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      ...db.write,
      $queryRaw: async () => [],
      $executeRaw: async () => 0,
      $executeRawUnsafe: async () => 0,
    })
  );
  const s3 = {
    send: vi.fn(async () => ({
      Body: { transformToByteArray: async () => holder.zipBytes },
    })),
  };
  return { mockNotify, db, s3, holder };
});

// 🔴 `approveRequest` LAZILY imports `app-listing.service` for its catalog-cache bust
// (#529), and that module statically imports `~/server/utils/cache-helpers`, whose module
// BODY builds a logger off the real env. Against this file's minimal `~/env/server` stub
// that construction throws `TypeError: Cannot read properties of undefined (reading
// 'includes')` at import time — inside the approve, so every approve case rejects rather
// than reporting a missing mock. Stub the two exports the listing service uses.
vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async (): Promise<unknown[]> => [],
  bustCacheTag: vi.fn(async () => undefined),
}));

vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: mockNotify,
}));
vi.mock('~/server/db/client', () => ({ dbRead: db.read, dbWrite: db.write }));
vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok',
    FORGEJO_WEBHOOK_SECRET: 'sec',
    APPS_DOMAIN: 'apps.example',
    NEXTAUTH_URL: 'https://civitai.example',
  },
}));
vi.mock('~/server/utils/app-block-ids', () => ({ newUlid: () => 'ULID000' }));
const { mockValidateSubmission } = vi.hoisted(() => ({
  mockValidateSubmission: vi.fn(async (..._a: unknown[]) => ({ valid: true, errors: [] })),
}));
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: {
    validate: () => ({ valid: true, errors: [] }),
    // approveRequest now calls the async submission gate (validate + settings-
    // pattern ReDoS check); this suite exercises the always-valid path.
    validateSubmission: mockValidateSubmission,
  },
}));
vi.mock('~/server/services/blocks/forgejo.service', () => ({
  commitFiles: vi.fn(async () => ({ sha: 'deadbeefsha' })),
  setCommitStatus: vi.fn(async () => undefined),
  createRepoFromTemplate: vi.fn(async () => ({ html_url: 'https://forgejo.example/x' })),
  ensurePushWebhook: vi.fn(async () => undefined),
  listRepoTreeAtRef: vi.fn(async () => new Map()),
  getBlobContent: vi.fn(async () => Buffer.from('')),
}));
vi.mock('~/server/services/blocks/apps-pipeline.service', () => ({
  triggerBuild: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-mapper', () => ({
  mapAppBlockToListing: () => ({ id: 'apl_mapped' }),
  // The approve path resolves the manifest `bugs` link beside the two builders; inert here.
  buildListingIssueTrackerSync: () => ({ write: false }),
  // The approve path also imports the manifest-governed copy re-sync builder
  // (subsequent-version approve). Stubbed so this suite stays focused on the
  // notification emission; the re-sync itself has its own suite
  // (publish-request.listingSync.test.ts).
  buildListingScalarSync: () => ({
    name: 'Cool App',
    description: null,
    tagline: null,
    category: null,
  }),
}));
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => s3,
}));
// A reject of a staff on-behalf submit withdraws its platform update through this service.
const { mockSupersede } = vi.hoisted(() => ({
  mockSupersede: vi.fn(async (a: { id: string }) => ({ id: a.id, status: 'superseded' as const })),
}));
vi.mock('~/server/services/blocks/app-platform-update.service', () => ({
  supersedePlatformUpdate: mockSupersede,
}));

const { approveRequest, rejectRequest } = await import(
  '~/server/services/blocks/publish-request.service'
);
const pipeline = await import('~/server/services/blocks/apps-pipeline.service');

const SUBMITTER = 4242;

/** A pending, subsequent-version request row (existing AppBlock ⇒ no repo creation). */
function pendingApproveRow() {
  return {
    id: 'req_appr_1',
    status: 'pending',
    slug: 'cool-app',
    version: '1.2.0',
    manifest: { name: 'Cool App', scopes: [] },
    bundleKey: 'bundles/cool-app.zip',
    forgejoCommitSha: '',
    submittedByUserId: SUBMITTER,
    appBlockId: 'apb_existing',
    deployState: null,
  };
}

function existingAppBlock() {
  return {
    id: 'apb_existing',
    appId: 'app_1',
    repoUrl: 'https://forgejo.example/cool-app',
    trustTier: 'unverified',
    app: { allowedScopes: 0n, allowedOrigins: ['https://cool-app.apps.example'] },
  };
}

beforeAll(async () => {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify({ name: 'Cool App', scopes: [] }));
  zip.file('index.html', '<html></html>');
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockNotify.mockResolvedValue(undefined);
  mockSupersede.mockImplementation(async (a: { id: string }) => ({
    id: a.id,
    status: 'superseded' as const,
  }));
  // Re-seed the default happy-path resolutions cleared by clearAllMocks.
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
  db.write.appBlock.updateMany.mockResolvedValue({ count: 0 });
  db.write.appBlock.findUnique.mockResolvedValue({ id: 'apb_existing' });
  db.write.oauthClient.update.mockResolvedValue({});
  db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
  db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing', kind: 'onsite' });
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
  (pipeline.triggerBuild as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('approveRequest — submitter notification (post-commit, best-effort)', () => {
  it('emits app-block-approved to the submitter with the right key + details', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());

    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.type).toBe('app-block-approved');
    expect(arg.userId).toBe(SUBMITTER);
    expect(arg.key).toBe('app-block-approved:req_appr_1');
    expect(arg.details).toMatchObject({ slug: 'cool-app', name: 'Cool App', version: '1.2.0' });
    // The manifest declares no page, so the approval must not link to the run page.
    expect((arg.details as { hasPage?: unknown }).hasPage).toBe(false);
    // No contentRating in the manifest reads as not mature.
    expect((arg.details as { mature?: unknown }).mature).toBe(false);
  });

  it('names the approving moderator and carries the trimmed approval note', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());

    await approveRequest({
      publishRequestId: 'req_appr_1',
      reviewerUserId: 9,
      approvalNotes: '  Nice work on the onboarding.  ',
    });

    const arg = mockNotify.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.attribution).toEqual({ kind: 'moderator', userId: 9 });
    expect((arg.details as { approvalNote?: unknown }).approvalNote).toBe(
      'Nice work on the onboarding.'
    );
  });

  it('carries no approval note when the moderator left none', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());

    await approveRequest({
      publishRequestId: 'req_appr_1',
      reviewerUserId: 9,
      approvalNotes: '  ',
    });

    const arg = mockNotify.mock.calls[0][0] as Record<string, unknown>;
    expect((arg.details as { approvalNote?: unknown }).approvalNote).toBeNull();
  });

  it('records hasPage and mature from a page app rated mature', async () => {
    const manifest = {
      name: 'Cool App',
      scopes: [],
      page: { path: '/', title: 'Cool App' },
      contentRating: 'r',
    };
    // Both manifest sources say so: the stored request row and the bundle.
    const zip = new JSZip();
    zip.file('block.manifest.json', JSON.stringify(manifest));
    zip.file('index.html', '<html></html>');
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    s3.send.mockImplementation(async () => ({ Body: { transformToByteArray: async () => bytes } }));
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingApproveRow(),
      manifest,
    });
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());

    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const details = (mockNotify.mock.calls[0][0] as { details: Record<string, unknown> }).details;
    expect(details.hasPage).toBe(true);
    expect(details.mature).toBe(true);
  });

  it('🔴 approve re-validates with the issue-tracker link LENIENT (a stored legacy `bugs` warns, never refuses)', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });
    expect(mockValidateSubmission).toHaveBeenCalled();
    expect(mockValidateSubmission.mock.calls[0][2]).toMatchObject({
      strictIssueTrackerLink: false,
    });
  });

  it('is BEST-EFFORT: a notify failure is swallowed and the approve still resolves', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    mockNotify.mockRejectedValueOnce(new Error('notifications down'));

    // The approve must resolve to its normal result despite the notify throw — the
    // status flip + build trigger already committed. (If the call site were made
    // non-swallowing, this await would REJECT and the test would fail.)
    await expect(
      approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_appr_1', appBlockId: 'apb_existing' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });

  it('POST-COMMIT ordering: a FAILED approve (non-pending row) emits nothing', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingApproveRow(),
      status: 'approved',
    });

    await expect(
      approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 })
    ).rejects.toThrow(/cannot approve/);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('POST-COMMIT ordering: notify runs AFTER the build trigger — a triggerBuild failure emits nothing', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    (pipeline.triggerBuild as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('tekton unavailable')
    );

    await expect(
      approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 })
    ).rejects.toThrow();
    // triggerBuild is BEFORE the notify in the flow → a build-trigger failure means
    // the submitter is never told the block was approved.
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe('rejectRequest — submitter notification (post-commit, best-effort)', () => {
  function pendingRejectRow() {
    return {
      id: 'req_rej_1',
      status: 'pending',
      deployState: null,
      slug: 'cool-app',
      version: '1.2.0',
      manifest: { name: 'Cool App' },
      submittedByUserId: SUBMITTER,
    };
  }

  it('emits app-block-rejected to the submitter with the trimmed reason + right key', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingRejectRow());

    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: '  Uses a disallowed scope  ',
    });

    expect(mockNotify).toHaveBeenCalledTimes(1);
    const arg = mockNotify.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.type).toBe('app-block-rejected');
    expect(arg.userId).toBe(SUBMITTER);
    expect(arg.key).toBe('app-block-rejected:req_rej_1');
    expect(arg.details).toMatchObject({
      slug: 'cool-app',
      name: 'Cool App',
      version: '1.2.0',
      reason: 'Uses a disallowed scope',
    });
    expect(arg.attribution).toEqual({ kind: 'moderator', userId: 9 });
    // The rejection row committed before the notify.
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledWith({
      where: { id: 'req_rej_1' },
      data: expect.objectContaining({
        status: 'rejected',
        rejectionReason: 'Uses a disallowed scope',
      }),
    });
  });

  it('is BEST-EFFORT: a notify failure is swallowed and the reject still resolves', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingRejectRow());
    mockNotify.mockRejectedValueOnce(new Error('notifications down'));

    await expect(
      rejectRequest({
        publishRequestId: 'req_rej_1',
        reviewerUserId: 9,
        rejectionReason: 'Uses a disallowed scope',
      })
    ).resolves.toBeUndefined();
    expect(mockNotify).toHaveBeenCalledTimes(1);
    // The reject still committed.
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledTimes(1);
  });

  it('POST-COMMIT ordering: a FAILED reject (non-pending row) emits nothing and never writes', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingRejectRow(),
      status: 'approved',
    });

    await expect(
      rejectRequest({
        publishRequestId: 'req_rej_1',
        reviewerUserId: 9,
        rejectionReason: 'Uses a disallowed scope',
      })
    ).rejects.toThrow(/cannot reject/);
    expect(db.write.appBlockPublishRequest.update).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('a too-short reason rejects BEFORE any DB read and emits nothing', async () => {
    await expect(
      rejectRequest({ publishRequestId: 'req_rej_1', reviewerUserId: 9, rejectionReason: 'x' })
    ).rejects.toThrow();
    expect(db.read.appBlockPublishRequest.findUnique).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  });
});

/**
 * A STAFF SUBMIT ON THE OWNER'S BEHALF (`fileSummary.onBehalf`): the request's submitter is the
 * moderator, so the outcome also goes to the app's OWNER, under its own type naming the staff
 * member. The moderator still gets the ordinary submitter notification.
 */
describe('approve / reject of a staff on-behalf submit — the owner is notified too', () => {
  const MODERATOR = 8001;
  const OWNER = 7101;
  const ON_BEHALF_SUMMARY = {
    files: [],
    added: [],
    removed: [],
    changed: [],
    onBehalf: {
      platformUpdateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
      staffUserId: MODERATOR,
      staffUsername: 'mod-ana',
      ownerUserId: OWNER,
      ownerUsername: 'owner-olga',
    },
  };
  const ORDINARY_SUMMARY = { files: [], added: [], removed: [], changed: [] };
  const calls = () => mockNotify.mock.calls.map((c) => c[0] as Record<string, unknown>);

  function rejectRow(fileSummary: unknown, submittedByUserId = MODERATOR) {
    return {
      id: 'req_rej_1',
      status: 'pending',
      deployState: null,
      slug: 'cool-app',
      version: '1.2.0',
      manifest: { name: 'Cool App' },
      submittedByUserId,
      fileSummary,
    };
  }

  it('approve: the moderator gets app-block-approved, the owner app-platform-update-approved', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingApproveRow(),
      submittedByUserId: MODERATOR,
      fileSummary: ON_BEHALF_SUMMARY,
    });
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());

    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });

    expect(calls()).toEqual([
      expect.objectContaining({
        type: 'app-block-approved',
        userId: MODERATOR,
        key: 'app-block-approved:req_appr_1',
      }),
      {
        type: 'app-platform-update-approved',
        userId: OWNER,
        key: 'app-platform-update-approved:req_appr_1',
        attribution: { kind: 'moderator', userId: 9 },
        details: {
          slug: 'cool-app',
          name: 'Cool App',
          version: '1.2.0',
          approvalNote: null,
          hasPage: false,
          mature: false,
          updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
          byUsername: 'mod-ana',
        },
      },
    ]);
  });

  it('reject: the moderator gets app-block-rejected, the owner app-platform-update-rejected with the reason', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(rejectRow(ON_BEHALF_SUMMARY));

    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: '  Breaks the gallery layout  ',
    });

    expect(calls()).toEqual([
      expect.objectContaining({
        type: 'app-block-rejected',
        userId: MODERATOR,
        key: 'app-block-rejected:req_rej_1',
      }),
      {
        type: 'app-platform-update-rejected',
        userId: OWNER,
        key: 'app-platform-update-rejected:req_rej_1',
        attribution: { kind: 'moderator', userId: 9 },
        details: {
          slug: 'cool-app',
          name: 'Cool App',
          version: '1.2.0',
          reason: 'Breaks the gallery layout',
          updateId: 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0',
          byUsername: 'mod-ana',
          updateWithdrawn: true,
        },
      },
    ]);
    // The reject read selects what the owner branch reads.
    expect(
      (db.read.appBlockPublishRequest.findUnique.mock.calls[0]![0] as { select: object }).select
    ).toMatchObject({ fileSummary: true });
  });

  it('the owner is told even when the submitter’s notification fails', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(rejectRow(ON_BEHALF_SUMMARY));
    mockNotify.mockRejectedValueOnce(new Error('notifications down'));

    await expect(
      rejectRequest({
        publishRequestId: 'req_rej_1',
        reviewerUserId: 9,
        rejectionReason: 'Breaks the gallery layout',
      })
    ).resolves.toBeUndefined();
    expect(calls().map((c) => [c.type, c.userId])).toEqual([
      ['app-block-rejected', MODERATOR],
      ['app-platform-update-rejected', OWNER],
    ]);
  });

  it('CONTROL: an ordinary request notifies ONLY its submitter (approve and reject)', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingApproveRow(),
      fileSummary: ORDINARY_SUMMARY,
    });
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });
    expect(calls().map((c) => [c.type, c.userId])).toEqual([['app-block-approved', SUBMITTER]]);

    mockNotify.mockClear();
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(
      rejectRow(ORDINARY_SUMMARY, SUBMITTER)
    );
    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: 'Breaks the gallery layout',
    });
    expect(calls().map((c) => [c.type, c.userId])).toEqual([['app-block-rejected', SUBMITTER]]);
  });

  it('an on-behalf record naming the submitter themselves sends no second copy', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(
      rejectRow(
        {
          ...ON_BEHALF_SUMMARY,
          onBehalf: { ...ON_BEHALF_SUMMARY.onBehalf, ownerUserId: MODERATOR },
        },
        MODERATOR
      )
    );
    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: 'Breaks the gallery layout',
    });
    expect(calls().map((c) => [c.type, c.userId])).toEqual([['app-block-rejected', MODERATOR]]);
  });
});

/**
 * OPERATOR DECISION "Reject withdraws it": rejecting a staff on-behalf submit also withdraws the
 * platform update it carried (`superseded`, by the rejecting moderator), through the
 * platform-update service's own supersede, and the owner is told. An approve leaves the update
 * alone; an ordinary reject touches no update.
 */
describe('reject of a staff on-behalf submit withdraws its platform update', () => {
  const MODERATOR = 8001;
  const OWNER = 7101;
  const UPDATE_ID = 'apu_01JABCDEFGHJKMNPQRSTVWXYZ0';
  const ON_BEHALF_SUMMARY = {
    files: [],
    onBehalf: {
      platformUpdateId: UPDATE_ID,
      staffUserId: MODERATOR,
      staffUsername: 'mod-ana',
      ownerUserId: OWNER,
      ownerUsername: 'owner-olga',
    },
  };
  const row = (fileSummary: unknown, submittedByUserId = MODERATOR) => ({
    id: 'req_rej_1',
    status: 'pending',
    deployState: null,
    slug: 'cool-app',
    version: '1.2.0',
    manifest: { name: 'Cool App' },
    submittedByUserId,
    fileSummary,
  });
  const ownerCall = () =>
    mockNotify.mock.calls
      .map((c) => c[0] as { type: string; details: Record<string, unknown> })
      .find((c) => c.type === 'app-platform-update-rejected');

  it('supersedes the update as the rejecting moderator, after the reject, and tells the owner', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(row(ON_BEHALF_SUMMARY));
    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: 'Breaks the gallery layout',
    });
    expect(mockSupersede).toHaveBeenCalledTimes(1);
    expect(mockSupersede).toHaveBeenCalledWith({ staffUserId: 9, id: UPDATE_ID });
    // After the request is rejected, before the owner hears about it.
    expect(db.write.appBlockPublishRequest.update.mock.invocationCallOrder[0]).toBeLessThan(
      mockSupersede.mock.invocationCallOrder[0]!
    );
    const ownerIdx = mockNotify.mock.calls.findIndex(
      (c) => (c[0] as { type: string }).type === 'app-platform-update-rejected'
    );
    expect(mockSupersede.mock.invocationCallOrder[0]).toBeLessThan(
      mockNotify.mock.invocationCallOrder[ownerIdx]!
    );
    expect(ownerCall()?.details).toMatchObject({
      updateId: UPDATE_ID,
      reason: 'Breaks the gallery layout',
      updateWithdrawn: true,
    });
  });

  it('an update that cannot be withdrawn (already merged) never fails the reject, and the owner is not told it was', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(row(ON_BEHALF_SUMMARY));
    mockSupersede.mockRejectedValueOnce(new Error('This update is already merged'));
    await expect(
      rejectRequest({
        publishRequestId: 'req_rej_1',
        reviewerUserId: 9,
        rejectionReason: 'Breaks the gallery layout',
      })
    ).resolves.toBeUndefined();
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledTimes(1);
    expect(ownerCall()).toBeDefined();
    expect(ownerCall()!.details).not.toHaveProperty('updateWithdrawn');
  });

  it('CONTROL: an approve of an on-behalf submit does NOT supersede the update', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      ...pendingApproveRow(),
      submittedByUserId: MODERATOR,
      fileSummary: ON_BEHALF_SUMMARY,
    });
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    await approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });
    // Positive control: the approve did run to its notifications.
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-platform-update-approved', userId: OWNER })
    );
    expect(mockSupersede).not.toHaveBeenCalled();
  });

  it('CONTROL: an ordinary (non-on-behalf) reject touches no update', async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(row({ files: [] }, SUBMITTER));
    await rejectRequest({
      publishRequestId: 'req_rej_1',
      reviewerUserId: 9,
      rejectionReason: 'Breaks the gallery layout',
    });
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'app-block-rejected', userId: SUBMITTER })
    );
    expect(mockSupersede).not.toHaveBeenCalled();
  });
});
