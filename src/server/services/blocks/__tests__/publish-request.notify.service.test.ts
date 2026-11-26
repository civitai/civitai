import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';
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
    // The staff platform-update shipped write (approve): see the describe at the end.
    $executeRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => 0),
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
// Only the staff platform-updates flag is answered here (off unless the describe at the end turns
// it on); every other flag reads as it did before.
const puFlag = vi.hoisted(() => ({ on: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => {
  const actual = await importOriginal<typeof FliptClient>();
  return {
    ...actual,
    isFlipt: (async (flag: string, ...rest: unknown[]) =>
      flag === actual.FLIPT_FEATURE_FLAGS.APP_BLOCKS_PLATFORM_UPDATES
        ? puFlag.on
        : (actual.isFlipt as (...a: unknown[]) => Promise<boolean>)(
            flag,
            ...rest
          )) as typeof actual.isFlipt,
  };
});
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

// ---------------------------------------------------------------------------
// STAFF PLATFORM UPDATES at approve (`platform-update-bundle-check.ts`), through this file's
// approve harness: the approve re-checks the bytes it approves and marks shipped, by this request,
// exactly the unshipped updates those bytes contain.
//
// 🔴 THE REGRESSION: at origin/main nothing marks an update shipped, so with the submit check
// every later submit of the app would be checked for it forever, and an owner's own later edit to
// the same lines would be refused.
// ---------------------------------------------------------------------------

const forgejo = await import('~/server/services/blocks/forgejo.service');
const { FORGEJO_SOURCE_ORG } = await import('~/server/services/blocks/forgejo-orgs');

describe('approveRequest — staff platform updates', () => {
  const BASE_SHA = 'b'.repeat(40);
  const IN_SHA = 'c'.repeat(40);
  const OUT_SHA = 'e'.repeat(40);
  const BASE_TEXT = 'export const a = 1;\n';
  const UPDATE_TEXT = 'export const a = 1;\nexport const staffFix = true;\n';
  const trees = new Map<string, Map<string, string>>();
  const blobs = new Map<string, Buffer>();
  let savedZip = new Uint8Array();

  const row = (id: string, commitSha: string, path: string, operation = 'update') => ({
    id,
    slug: 'cool-app',
    reason: 'Fix it',
    baseCommitSha: BASE_SHA,
    commitSha,
    paths: [{ path, operation }],
    staffUsername: 'mod-jane',
    staffIsModerator: true,
    staffBannedAt: null,
    staffDeletedAt: null,
  });
  const isUpdateQuery = (sql: unknown) => JSON.stringify(sql).includes('app_platform_updates');

  async function setBundle(files: Record<string, string>) {
    const zip = new JSZip();
    zip.file('block.manifest.json', JSON.stringify({ name: 'Cool App', scopes: [] }));
    zip.file('index.html', '<html></html>');
    for (const [p, c] of Object.entries(files)) zip.file(p, c);
    holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
  }

  /** The `shipped` UPDATEs approve ran: [ids, publishRequestId]. */
  const shippedWrites = () =>
    (db.write.$executeRaw.mock.calls as unknown[][])
      .filter(([strings]) =>
        (strings as string[]).join('?').includes('shipped_in_publish_request_id')
      )
      .map(([, publishRequestId, ids]) => [ids, publishRequestId]);

  const approve = async () => {
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce(pendingApproveRow());
    db.read.appBlock.findFirst.mockResolvedValueOnce(existingAppBlock());
    return approveRequest({ publishRequestId: 'req_appr_1', reviewerUserId: 9 });
  };

  beforeEach(() => {
    savedZip = holder.zipBytes;
    puFlag.on = true;
    blobs.clear();
    blobs.set('blob-base', Buffer.from(BASE_TEXT));
    blobs.set('blob-in', Buffer.from(UPDATE_TEXT));
    blobs.set('blob-out', Buffer.from('export {};\n'));
    trees.clear();
    trees.set(`${FORGEJO_SOURCE_ORG}@${BASE_SHA}`, new Map([['src/a.ts', 'blob-base']]));
    trees.set(`${FORGEJO_SOURCE_ORG}@${IN_SHA}`, new Map([['src/a.ts', 'blob-in']]));
    trees.set(
      `${FORGEJO_SOURCE_ORG}@${OUT_SHA}`,
      new Map([
        ['src/a.ts', 'blob-base'],
        ['src/new.ts', 'blob-out'],
      ])
    );
    vi.mocked(forgejo.listRepoTreeAtRef).mockImplementation(async (_slug, ref, org) => {
      const tree = trees.get(`${org ?? 'build'}@${ref}`);
      if (!tree) throw new Error(`no tree ${org ?? 'build'}@${ref}`);
      return tree;
    });
    vi.mocked(forgejo.getBlobContent).mockImplementation(async (_slug, sha) => {
      const blob = blobs.get(sha);
      if (!blob) throw new Error(`no blob ${sha}`);
      return blob;
    });
    const rows = [
      row('apu_in', IN_SHA, 'src/a.ts'),
      row('apu_out', OUT_SHA, 'src/new.ts', 'create'),
    ];
    db.write.$queryRaw.mockImplementation(async (sql: unknown) => (isUpdateQuery(sql) ? rows : []));
    db.write.$executeRaw.mockResolvedValue(1);
  });

  afterEach(() => {
    holder.zipBytes = savedZip;
    puFlag.on = false;
    vi.mocked(forgejo.listRepoTreeAtRef).mockImplementation(async () => new Map());
    vi.mocked(forgejo.getBlobContent).mockImplementation(async () => Buffer.from(''));
    db.write.$queryRaw.mockImplementation(async () => []);
    db.write.$executeRaw.mockImplementation(async () => 0);
  });

  it('🔴 marks shipped, by this request, only the updates the approved bundle contains', async () => {
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    await approve();
    expect(shippedWrites()).toEqual([[['apu_in'], 'req_appr_1']]);
  });

  it('marks nothing when the approved bundle contains none of them', async () => {
    await setBundle({ 'src/a.ts': BASE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_1');
    expect(shippedWrites()).toEqual([]);
    // Positive control: the check ran against the record.
    expect(
      (db.write.$queryRaw.mock.calls as unknown[][]).filter(([sql]) => isUpdateQuery(sql))
    ).toHaveLength(1);
  });

  it('with the flag off, marks nothing and the approve stands', async () => {
    puFlag.on = false;
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_1');
    expect(shippedWrites()).toEqual([]);
  });

  it('never fails the approve: an unreadable source repo marks nothing', async () => {
    trees.delete(`${FORGEJO_SOURCE_ORG}@${IN_SHA}`);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await setBundle({ 'src/a.ts': UPDATE_TEXT });
    const result = await approve();
    expect(result.publishRequestId).toBe('req_appr_1');
    expect(shippedWrites()).toEqual([]);
    warn.mockRestore();
  });
});
