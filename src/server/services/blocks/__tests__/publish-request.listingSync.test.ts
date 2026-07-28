import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `approveRequest` (3b) — onsite AppListing CREATE vs manifest-governed COPY RE-SYNC.
 *
 * An onsite store listing's `name` / `tagline` / `description` / `category` have
 * NO author surface other than the block manifest (the /apps/[appBlockId]/edit
 * Listing tab is media-only, and `applyApprovedRevision`'s onsite branch copies
 * ONLY assets). Before the re-sync those scalars were snapshotted ONCE at the
 * FIRST approve and never refreshed, so a developer who added a description (or
 * a tagline) in a later version kept seeing "Missing description / tagline" on
 * /apps/my-submissions forever and the store kept serving the v1 copy.
 *
 * What these tests pin:
 *   1. FIRST approve (no listing yet) → CREATE, byte-identical to before: the
 *      mapper payload, and NO update write at all.
 *   2. SUBSEQUENT approve (listing exists) → an `updateMany` scoped to
 *      `{ appBlockId, kind: 'onsite' }` carrying EXACTLY the manifest-governed
 *      scalars — and NEVER a create.
 *   3. `category` comes from `AppBlock.category` (mod curation survives), not
 *      straight from the manifest.
 *   4. Curated / mod-owned columns (assets, featured, contentRating, status,
 *      slug) are NOT in the update payload.
 *   5. The re-sync is BEST-EFFORT: a failing write is swallowed and the
 *      approve/deploy still succeeds.
 *
 * The mapper module is NOT mocked here — the point is that the real
 * `mapAppBlockToListing` / `buildListingScalarSync` payloads reach the DB layer.
 */

const { db, s3, holder } = vi.hoisted(() => {
  const holder: { zipBytes: Uint8Array } = { zipBytes: new Uint8Array() };
  const makeDb = () => ({
    appBlockPublishRequest: {
      findUnique: vi.fn(async (..._a: unknown[]): Promise<unknown> => null),
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
  const s3 = {
    send: vi.fn(async () => ({
      Body: { transformToByteArray: async () => holder.zipBytes },
    })),
  };
  return { db, s3, holder };
});

vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
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

const { approveRequest } = await import('~/server/services/blocks/publish-request.service');

/** The manifest the NEW version being approved declares. */
const NEW_MANIFEST = {
  name: 'Cool App v2',
  description: 'Now with more cool.',
  tagline: '  The coolest app  ',
  scopes: [],
};

/** A pending, SUBSEQUENT-version request row (an AppBlock already exists). */
function pendingRow() {
  return {
    id: 'req_1',
    status: 'pending',
    slug: 'cool-app',
    version: '1.2.0',
    manifest: NEW_MANIFEST,
    bundleKey: 'bundles/cool-app.zip',
    forgejoCommitSha: '',
    submittedByUserId: 4242,
    appBlockId: 'apb_1',
    deployState: null,
  };
}

function existingAppBlock() {
  return {
    id: 'apb_1',
    appId: 'app_1',
    repoUrl: 'https://forgejo.example/cool-app',
    trustTier: 'unverified',
    app: { allowedScopes: 0, allowedOrigins: ['https://cool-app.apps.example'] },
  };
}

/** The (3b) read of the freshly-approved AppBlock's own columns. */
function appBlockRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'apb_1',
    blockId: 'cool-app',
    manifest: NEW_MANIFEST,
    contentRating: 'pg',
    category: 'utility',
    featured: false,
    featuredOrder: null,
    externalUrl: null,
    app: { userId: 42 },
    ...overrides,
  };
}

beforeAll(async () => {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(NEW_MANIFEST));
  zip.file('index.html', '<html></html>');
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
  db.write.appBlock.updateMany.mockResolvedValue({ count: 0 });
  db.write.appBlock.findUnique.mockResolvedValue(appBlockRow());
  db.write.oauthClient.update.mockResolvedValue({});
  db.write.appListing.create.mockResolvedValue({ id: 'apl_created' });
  db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
  db.write.appListing.findFirst.mockResolvedValue(null);
  db.read.appBlockPublishRequest.findUnique.mockResolvedValue(pendingRow());
  db.read.appBlock.findFirst.mockResolvedValue(existingAppBlock());
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
});

afterAll(() => {
  vi.restoreAllMocks();
});

/** The (3b) listing write calls, ignoring the unrelated (3b-reset) restore flip. */
function scalarSyncCalls() {
  return db.write.appListing.updateMany.mock.calls.filter((c) => {
    const arg = c[0] as { data?: Record<string, unknown> };
    // The (3b-reset) restore writes ONLY `{ status: 'approved' }`.
    return arg?.data != null && !('status' in arg.data);
  });
}

describe('approveRequest (3b) — FIRST approve creates the listing (path unchanged)', () => {
  it('CREATES via the mapper and performs NO manifest-governed update write', async () => {
    db.read.appListing.findUnique.mockResolvedValue(null);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(db.write.appListing.create).toHaveBeenCalledTimes(1);
    const created = (db.write.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
    // The full mapper payload — including the newly-mapped tagline (trimmed).
    expect(created).toEqual({
      id: 'apl_fixed',
      kind: 'onsite',
      slug: 'cool-app',
      name: 'Cool App v2',
      description: 'Now with more cool.',
      tagline: 'The coolest app',
      iconId: null,
      coverId: null,
      category: 'utility',
      status: 'approved',
      contentRating: 'pg',
      externalUrl: null,
      connectClientId: null,
      appBlockId: 'apb_1',
      featured: false,
      featuredOrder: null,
      userId: 42,
    });
    // The create path must not also run the re-sync.
    expect(scalarSyncCalls()).toHaveLength(0);
  });

  it('still skips the create when the AppBlock has no resolvable owner (unchanged)', async () => {
    db.read.appListing.findUnique.mockResolvedValue(null);
    db.write.appBlock.findUnique.mockResolvedValue(appBlockRow({ app: null }));

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(db.write.appListing.create).not.toHaveBeenCalled();
    expect(scalarSyncCalls()).toHaveLength(0);
  });
});

describe('approveRequest (3b-sync) — SUBSEQUENT approve re-syncs manifest-governed copy', () => {
  beforeEach(() => {
    // A listing already exists for this app ⇒ the re-sync branch.
    db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing' });
  });

  it('updates name/description/tagline/category from the new manifest and never creates', async () => {
    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(db.write.appListing.create).not.toHaveBeenCalled();
    const calls = scalarSyncCalls();
    expect(calls).toHaveLength(1);
    const arg = calls[0][0] as { where: Record<string, unknown>; data: Record<string, unknown> };
    expect(arg.where).toEqual({ appBlockId: 'apb_1', kind: 'onsite' });
    expect(arg.data).toEqual({
      name: 'Cool App v2',
      description: 'Now with more cool.',
      tagline: 'The coolest app',
      category: 'utility',
    });
  });

  it('writes EXACTLY the manifest-governed keys — no curated/mod-owned column is touched', async () => {
    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const arg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data).sort()).toEqual(['category', 'description', 'name', 'tagline']);
    for (const curated of [
      'iconId',
      'coverId',
      'featured',
      'featuredOrder',
      'contentRating',
      'status',
      'slug',
      'externalUrl',
      'userId',
    ]) {
      expect(arg.data).not.toHaveProperty(curated);
    }
  });

  it('takes category from AppBlock.category (mod curation), NOT the manifest', async () => {
    // The manifest asks for `games`; a moderator already curated `analytics`
    // onto the AppBlock (step (3a) is null-gated so it does not overwrite it).
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      ...pendingRow(),
      manifest: { ...NEW_MANIFEST, category: 'games' },
    });
    db.write.appBlock.findUnique.mockResolvedValue(
      appBlockRow({
        category: 'analytics',
        manifest: { ...NEW_MANIFEST, category: 'games' },
      })
    );

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const arg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    expect(arg.data.category).toBe('analytics');
  });

  it('CLEARS a removed description/tagline (manifest-governed means the manifest wins)', async () => {
    const stripped = { name: 'Cool App v2', scopes: [] };
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      ...pendingRow(),
      manifest: stripped,
    });
    db.write.appBlock.findUnique.mockResolvedValue(
      appBlockRow({ manifest: stripped, category: null })
    );

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const arg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    expect(arg.data).toEqual({
      name: 'Cool App v2',
      description: null,
      tagline: null,
      category: null,
    });
  });

  it('is BEST-EFFORT: a failing re-sync write does not fail the approve/deploy', async () => {
    db.write.appListing.updateMany.mockRejectedValueOnce(new Error('db blip'));

    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
  });

  it('skips the re-sync when the AppBlock row cannot be read (no blind write)', async () => {
    db.write.appBlock.findUnique.mockResolvedValue(null);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(scalarSyncCalls()).toHaveLength(0);
    expect(db.write.appListing.create).not.toHaveBeenCalled();
  });
});
