import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
    appBlockPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
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
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      update: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
    },
    appListing: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ id: 'apl_existing' })),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? {}),
      updateMany: vi.fn(async (..._a: unknown[]) => ({ count: 0 })),
    },
  });
  const db = { read: makeDb(), write: makeDb() };
  const s3 = {
    send: vi.fn(async () => ({
      Body: { transformToByteArray: async () => holder.zipBytes },
    })),
  };
  return { mockNotify, db, s3, holder };
});

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
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: { validate: () => ({ valid: true, errors: [] }) },
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
    app: { allowedScopes: 0, allowedOrigins: ['https://cool-app.apps.example'] },
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
  db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
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
    // The rejection row committed before the notify.
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledWith({
      where: { id: 'req_rej_1' },
      data: expect.objectContaining({ status: 'rejected', rejectionReason: 'Uses a disallowed scope' }),
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
