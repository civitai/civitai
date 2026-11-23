import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';
vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

/**
 * `approveRequest` — the App Storage `keyedBy` immutability gate at APPROVE
 * (docs/app-storage-generic-core.md, "Viewer-keyed documents"): a push-originated request never
 * passes `submitVersion`, so approve must refuse it too, against EVERY earlier approval. The only
 * approval that declared `votes` is the 51st newest, outside the capped schema-diff history, so
 * only `baseline.approved` at the approve call site can see it.
 *
 * The harness is `publish-request.listingSync.test.ts`'s (the db, S3, Forgejo and validator
 * boundaries stubbed); the storage-migration modules are real.
 */

const { db, s3, holder } = vi.hoisted(() => {
  const holder: { zipBytes: Uint8Array } = { zipBytes: new Uint8Array() };
  const makeDb = () => ({
    $queryRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => []),
    // The storage-migration approve gate (`reserveStorageMigrationRuns`): no open run.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        $queryRaw: async () => [],
        $executeRaw: async () => 0,
        $executeRawUnsafe: async () => 0,
      })
    ),
    $executeRaw: vi.fn(async (..._a: unknown[]): Promise<unknown> => 0),
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
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
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
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      findFirst: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
      create: vi.fn(async (a: { data?: unknown }) => a?.data ?? { id: 'apl_created' }),
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
  return { db, s3, holder };
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
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
}));
vi.mock('~/server/db/client', () => ({ dbRead: db.read, dbWrite: db.write }));

// The post-commit history write is a seam: these suites pin what each go-live HANDS it;
// `app-listing-rating.test.ts` pins that it writes one event only when the value changed.
const { recordRatingChange } = vi.hoisted(() => ({
  recordRatingChange: vi.fn(async (..._a: unknown[]): Promise<void> => undefined),
}));
vi.mock('~/server/services/blocks/app-listing-rating', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingRating>()),
  recordListingRatingChangeAfterCommit: (...a: unknown[]) => recordRatingChange(...a),
}));
vi.mock('~/env/server', () => ({
  env: {
    FORGEJO_BASE_URL: 'https://forgejo.example',
    FORGEJO_ADMIN_TOKEN: 'tok',
    FORGEJO_WEBHOOK_SECRET: 'sec',
    APPS_DOMAIN: 'apps.example',
    NEXTAUTH_URL: 'https://civitai.example',
  },
}));
vi.mock('~/server/utils/app-block-ids', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('~/server/utils/app-block-ids');
  return { ...actual, newUlid: () => 'ULID000', newAppListingId: () => 'apl_fixed' };
});
vi.mock('~/server/services/block-manifest-validator.service', () => ({
  BlockManifestValidator: {
    validate: () => ({ valid: true, errors: [] }),
    validateSubmission: async () => ({ valid: true, errors: [] }),
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
vi.mock('~/utils/bundle-s3', () => ({
  getBundleBucket: () => 'bundles',
  getBundleS3Client: () => s3,
}));
// W13 draft-at-submit: the (3b-transition) + (3b-reset) go-live scan-clean gate is a
// no-op here (media scan-clean is exercised in the assets-service suite). Both are
// dynamic imports, so mocking just the helpers the approve path pulls is safe.
// `resolveListingRatingFloorInTx` defaults to IDENTITY (returns the declared rating
// unchanged = no mature media attached); the raise-only derive itself is unit-tested
// for real in the assets-service suite. A test below overrides it to pin that the
// transition writes the FLOOR's result, not the raw AppBlock rating.
vi.mock('~/server/services/blocks/app-listing-assets.service', () => ({
  assertListingAssetsScanCleanInTx: vi.fn(async () => undefined),
  resolveListingRatingFloorInTx: vi.fn(
    async (_db: unknown, _id: string, declared: string | null) => declared
  ),
  // The version re-rate, as identity on the new declaration (the real rule is pinned in
  // listing-media-split.approve-request.test.ts).
  resolveVersionListingRating: vi.fn(
    async (_db: unknown, a: { nextDeclared: string | null }) => a.nextDeclared
  ),
}));

const { approveRequest } = await import('~/server/services/blocks/publish-request.service');

const SLUG = 'vote-board-4c2a';
const NEW_MANIFEST = {
  name: 'Vote Board',
  scopes: ['apps:storage'],
  storage: { collections: { votes: { visibility: 'shared', write: 'none', counters: ['n'] } } },
};
const ENFORCED = {
  name: 'Vote Board',
  scopes: ['apps:storage'],
  storage: { collections: { notes: { visibility: 'private' } } },
};
const OLD_VOTES = {
  name: 'Vote Board',
  storage: { collections: { votes: { visibility: 'shared', write: 'own', keyedBy: 'viewer' } } },
};

function pendingRow() {
  return {
    id: 'req_vk',
    status: 'pending',
    slug: SLUG,
    version: '3.0.0',
    manifest: NEW_MANIFEST,
    bundleKey: 'bundles/vote-board.zip',
    forgejoCommitSha: '',
    submittedByUserId: 4243,
    appBlockId: 'apb_vk',
    deployState: null,
  };
}

const approvals = (withOld: boolean) => [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `pubreq_r${i}`, manifest: ENFORCED })),
  ...(withOld ? [{ id: 'pubreq_old', manifest: OLD_VOTES }] : []),
];

beforeAll(async () => {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(NEW_MANIFEST));
  zip.file('index.html', '<html></html>');
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.read.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRow());
  db.read.appBlock.findFirst.mockResolvedValue({
    id: 'apb_vk',
    appId: 'app_vk',
    repoUrl: 'https://forgejo.example/vote-board',
    trustTier: 'unverified',
    app: { allowedScopes: 0n, allowedOrigins: ['https://vote-board.apps.example'] },
  });
  // What the store enforces (the baseline): no `votes`.
  db.write.appBlock.findFirst.mockResolvedValue({ id: 'apb_vk', manifest: ENFORCED });
  db.write.appBlock.findUnique.mockResolvedValue({
    id: 'apb_vk',
    blockId: SLUG,
    manifest: NEW_MANIFEST,
    contentRating: 'pg',
    category: 'utility',
    featured: false,
    featuredOrder: null,
    externalUrl: null,
    app: { userId: 42 },
  });
  db.write.oauthClient.findUnique.mockResolvedValue({ allowedScopes: 0n });
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe('approveRequest — keyedBy immutability against every approval', () => {
  it('🔴 refuses dropping keyedBy a 51st-newest approval declared, before the request is approved', async () => {
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(approvals(true));
    await expect(approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 })).rejects.toThrow(
      'storage.collections.votes: an approved version declared it with keyedBy "viewer"'
    );
    // The baseline read every approval: no cap on the query.
    const query = db.write.appBlockPublishRequest.findMany.mock.calls.at(-1)?.[0] as {
      take?: number;
    };
    expect(query.take).toBeUndefined();
  });

  it('positive control: without that approval the storage gate passes', async () => {
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(approvals(false));
    const outcome = await approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 }).then(
      () => null,
      (err: Error) => err.message
    );
    // Whatever later step this stubbed harness reaches, it is not the keyedBy refusal.
    expect(outcome ?? '').not.toContain('keyedBy');
  });
});
