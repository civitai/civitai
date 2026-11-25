import { Prisma } from '@prisma/client';
import JSZip from 'jszip';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
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
 *   4. Curated / mod-owned columns (assets, featured, status, slug) are NOT in
 *      the update payload. `contentRating` is, floored at the media, when the
 *      primary read finds the listing: listing-media-split.approve-request.test.ts.
 *   5. The re-sync is BEST-EFFORT: a failing write is swallowed and the
 *      approve/deploy still succeeds.
 *
 * The mapper module is NOT mocked here — the point is that the real
 * `mapAppBlockToListing` / `buildListingScalarSync` payloads reach the DB layer.
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

const { approveRequest, draftTransitionWhere, resetRestoreWhere } = await import(
  '~/server/services/blocks/publish-request.service'
);

/** The manifest the NEW version being approved declares. */
const NEW_MANIFEST = {
  name: 'Cool App v2',
  description: 'Now with more cool.',
  tagline: '  The coolest app  ',
  // Deliberately NON-canonical (trailing `.git`) so every assertion below pins the
  // NORMALISED value — a mapper that passed the manifest string through verbatim
  // would fail here rather than quietly storing a spelling the material-change
  // comparison cannot match.
  repository: 'https://github.com/civitai/cool-app.git',
  scopes: [],
};

/** What `resolveListingSourceRepo` must normalise `NEW_MANIFEST.repository` to. */
const NEW_MANIFEST_REPO_CANONICAL = 'https://github.com/civitai/cool-app';

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
    app: { allowedScopes: 0n, allowedOrigins: ['https://cool-app.apps.example'] },
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
  // The ceiling a late hold would put back, read on the primary before step (3).
  db.write.oauthClient.findUnique.mockResolvedValue({ allowedScopes: 0n });
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
    // The (3b-reset) restore writes `status` (+ the go-live rating floor); the
    // manifest scalar sync never writes `status`, so keying on its absence separates them.
    return arg?.data != null && !('status' in arg.data);
  });
}

describe('approveRequest (3b) — FIRST approve creates the listing (path unchanged)', () => {
  it('CREATES via the mapper and performs NO manifest-governed update write', async () => {
    db.read.appListing.findUnique.mockResolvedValue(null);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(db.write.appListing.create).toHaveBeenCalledTimes(1);
    const created = (
      db.write.appListing.create.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    // The full mapper payload — including the newly-mapped tagline (trimmed).
    expect(created).toEqual({
      id: 'apl_fixed',
      kind: 'onsite',
      slug: 'cool-app',
      name: 'Cool App v2',
      description: 'Now with more cool.',
      tagline: 'The coolest app',
      // Normalised at the create path too (the manifest spells it with a `.git`).
      sourceRepoUrl: NEW_MANIFEST_REPO_CANONICAL,
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
    db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing', kind: 'onsite' });
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
      sourceRepoUrl: NEW_MANIFEST_REPO_CANONICAL,
      category: 'utility',
    });
  });

  it('writes EXACTLY the manifest-governed keys — no curated/mod-owned column is touched', async () => {
    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const arg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    expect(Object.keys(arg.data).sort()).toEqual([
      'category',
      'description',
      'name',
      'sourceRepoUrl',
      'tagline',
    ]);
    for (const curated of [
      'iconId',
      'coverId',
      'featured',
      'featuredOrder',
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
      // 🔴 CLEARED, not left alone. `stripped` carries no `repository` key, and
      // manifest-governed means the manifest is the whole truth — an author who
      // removes the key must see the Source row disappear from the store.
      sourceRepoUrl: null,
      category: null,
    });
  });

  it('🔴 RE-SYNCS the source repo on version N+1 — SETS a link the new manifest added', async () => {
    // THE BUG THIS EXISTS FOR: wiring `sourceRepoUrl` into `mapAppBlockToListing` (the
    // FIRST-approve create) but not into `buildListingScalarSync` (the re-sync) would
    // set it once, at the first approve, and never look again — so an author who added
    // `repository` in v1.1.0 would never see it, and one who removed it would keep
    // serving a dead link forever. Both directions asserted, on the RE-SYNC path.
    //
    // The two manifests differ from each other AND from NEW_MANIFEST's value, so a
    // resolver hardcoded to any single constant fails.
    const added = {
      name: 'Cool App v2',
      scopes: [],
      repository: 'https://gitlab.com/other-org/other-app/',
    };
    db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
      ...pendingRow(),
      manifest: added,
    });
    db.write.appBlock.findUnique.mockResolvedValue(
      appBlockRow({ manifest: added, category: null })
    );

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const setArg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    // Normalised: the trailing slash is stripped, and the host is the one the manifest
    // named — not github, which every OTHER fixture in this file uses. A resolver
    // hardcoded to any single constant fails on this value.
    expect(setArg.data.sourceRepoUrl).toBe('https://gitlab.com/other-org/other-app');
  });

  it('🔴 RE-SYNCS the source repo on version N+1 — CLEARS a link the new manifest dropped', async () => {
    // The other half of the re-sync guard (split into its own case so each gets a clean
    // `beforeEach` arm of the db fakes rather than sharing one test's consumed state).
    // A link that is set once and never re-read leaves the store serving a repo the
    // author deliberately removed.
    {
      const removed = { name: 'Cool App v2', scopes: [] };
      db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
        ...pendingRow(),
        manifest: removed,
      });
      db.write.appBlock.findUnique.mockResolvedValue(
        appBlockRow({ manifest: removed, category: null })
      );

      await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

      const clearArg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
      // PRESENT-and-null, never absent: absent would leave the stale link in place.
      expect(clearArg.data).toHaveProperty('sourceRepoUrl');
      expect(clearArg.data.sourceRepoUrl).toBeNull();
    }
  });

  it('🔴 OMITS the column entirely when the manual-apply migration has NOT been applied', async () => {
    // `app_listings.source_repo_url` is manual-apply. Between this deploy and a human
    // running the SQL, naming the column in this payload raises P2022 — and this whole
    // block is log-and-continue, so the store copy would silently stop re-syncing with
    // nothing but a warn line. The probe must therefore OMIT the key, not write null.
    //
    // The probe is `appListing.findUnique` with `select: { sourceRepoUrl: true }`; make
    // exactly that call throw the Prisma missing-column error.
    db.write.appListing.findUnique.mockImplementationOnce(async () => {
      const err = new Error('The column `source_repo_url` does not exist') as Error & {
        code?: string;
      };
      err.code = 'P2022';
      throw err;
    });

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const arg = scalarSyncCalls()[0][0] as { data: Record<string, unknown> };
    // ABSENT, not null — a `null` here would be the P2022 this guard exists to avoid.
    expect(arg.data).not.toHaveProperty('sourceRepoUrl');
    // …and every pre-existing manifest-governed column is still written, so the guard
    // degrades ONE field rather than disabling the re-sync.
    expect(Object.keys(arg.data).sort()).toEqual(['category', 'description', 'name', 'tagline']);
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

  it('REFUSES to sync onto an off-site listing — and says so instead of failing silently', async () => {
    // An off-site listing's name/tagline/description are AUTHOR-supplied through
    // the submit wizard, NOT manifest-governed, so writing manifest copy onto one
    // would clobber the author's edits. approveRequest only ever produces hosted
    // blocks, so this is anomalous — which is exactly why it must be LOUD rather
    // than a silent zero-row no-op that disables the feature unnoticed.
    db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_existing', kind: 'offsite' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(scalarSyncCalls()).toHaveLength(0);
    expect(db.write.appListing.create).not.toHaveBeenCalled();
    expect(
      warn.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('skipping listing copy re-sync') &&
          c[0].includes("kind='offsite'")
      )
    ).toBe(true);
    warn.mockRestore();
  });

  it('WARNS when the re-sync matches zero rows (replica lag) instead of silently skipping', async () => {
    // The replica said a listing exists but the PRIMARY matched none. Benign and
    // self-converging, but invisible-by-default would mean the store quietly keeps
    // serving the previously-approved copy — the exact bug this re-sync fixes.
    db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(scalarSyncCalls()).toHaveLength(1);
    expect(
      warn.mock.calls.some(
        (c) => typeof c[0] === 'string' && c[0].includes('re-sync matched 0 rows')
      )
    ).toBe(true);
    warn.mockRestore();
  });
});

describe('approveRequest (3b-transition) — draft-at-submit transitions the pending draft → approved', () => {
  // Return the pre-approval draft for the slug-scoped resolve, null for the
  // (3b-reset) appBlockId+pending probe (so the unrelated reset branch stays inert).
  // `media` defaults to an icon AND a cover — the publish floor every go-live needs; the
  // floor tests below pass a draft missing one.
  function draftFor(
    id: string,
    media: { iconId: number | null; coverId: number | null } = { iconId: 11, coverId: 22 }
  ) {
    return async (...a: unknown[]) => {
      const w = (a[0] as { where?: Record<string, unknown> } | undefined)?.where ?? {};
      if (w.status === 'draft' && w.appBlockId === null) return { id, ...media };
      return null;
    };
  }

  it('TRANSITIONS the draft in place (appBlockId+approved+scalars) and does NOT create a second listing; media (icon/cover) is NEVER touched', async () => {
    db.write.appListing.findFirst.mockImplementation(draftFor('apl_draft'));
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    // No fresh create — the existing draft BECOMES the approved listing (media preserved).
    expect(db.write.appListing.create).not.toHaveBeenCalled();

    // The transition updateMany carries appBlockId + status:approved + manifest scalars,
    // status-guarded on the draft.
    const transitionCall = db.write.appListing.updateMany.mock.calls.find((c) => {
      const d = (c[0] as { data?: Record<string, unknown> })?.data ?? {};
      return 'appBlockId' in d;
    });
    expect(transitionCall).toBeDefined();
    const arg = transitionCall![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    // Status-guarded AND media-guarded: the write itself cannot publish an art-less draft.
    expect(arg.where).toEqual({
      id: 'apl_draft',
      status: 'draft',
      iconId: { not: null },
      coverId: { not: null },
    });
    expect(arg.data).toEqual({
      appBlockId: 'apb_1',
      status: 'approved',
      contentRating: 'pg',
      name: 'Cool App v2',
      description: 'Now with more cool.',
      tagline: 'The coolest app',
      sourceRepoUrl: NEW_MANIFEST_REPO_CANONICAL,
      category: 'utility',
    });
    // 🔴 Media columns are NEVER in the transition payload — icon/cover survive approval.
    expect(arg.data).not.toHaveProperty('iconId');
    expect(arg.data).not.toHaveProperty('coverId');
  });

  it('the floor ALLOWS an approve whose draft has an icon AND a cover (transition runs)', async () => {
    db.write.appListing.findFirst.mockImplementation(
      draftFor('apl_draft', { iconId: 11, coverId: 22 })
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
    expect(db.write.appListing.create).not.toHaveBeenCalled();
  });

  it('LEGACY COMPAT: a pending request with NO draft (pre-ship) still CREATES the listing the old way at approve', async () => {
    // Simulate a request that predates draft-at-submit: no draft resolvable by slug, and
    // no listing keyed by appBlockId → falls through to the legacy mapper-create path.
    db.write.appListing.findFirst.mockResolvedValue(null);
    db.read.appListing.findUnique.mockResolvedValue(null);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(db.write.appListing.create).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 🔴 RATING FLOOR at go-live. The AppBlock's contentRating is MANIFEST-declared
  // (author-controlled) and the attach path deliberately accepts an image ABOVE the
  // declared rating (see the assets suite: "setIcon ATTACHES an over-declared-rating
  // image (X image on a g listing)") because draft/pending listings are "rated at
  // approve". This is that approve — so it must stamp the FLOORED rating, never the
  // raw declared one, or mature media goes live on a g-rated card and passes
  // listingMatureFilter(redCapable=false) to SFW-only users.
  // -------------------------------------------------------------------------
  it('stamps the MEDIA-DERIVED floor, not the manifest-declared rating, when the pending media is more mature', async () => {
    const assets = await import('~/server/services/blocks/app-listing-assets.service');
    // The draft carries an R-rated icon the author attached while pending; the
    // AppBlock/manifest still declares 'pg'.
    // `Once` so the identity default is restored for the following tests (clearAllMocks
    // clears calls, not implementations).
    vi.mocked(assets.resolveListingRatingFloorInTx).mockResolvedValueOnce('r');
    db.write.appListing.findFirst.mockImplementation(draftFor('apl_draft'));
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    // The floor is resolved against THIS draft's id, on the primary client.
    expect(assets.resolveListingRatingFloorInTx).toHaveBeenCalledWith(
      expect.anything(),
      'apl_draft',
      'pg',
      false
    );
    const transitionCall = db.write.appListing.updateMany.mock.calls.find(
      (c) => 'appBlockId' in (((c[0] as { data?: Record<string, unknown> })?.data ?? {}) as object)
    );
    const data = (transitionCall![0] as { data: Record<string, unknown> }).data;
    // 🔴 The RAISED rating is what goes live — NOT the declared 'pg'.
    expect(data.contentRating).toBe('r');
    expect(recordRatingChange).toHaveBeenCalledTimes(1);
    expect(recordRatingChange).toHaveBeenCalledWith({
      appListingId: 'apl_draft',
      slug: 'cool-app',
      before: 'pg',
      after: 'r',
      actorUserId: 9,
    });
  });

  it('a transition that matched no row hands the history nothing', async () => {
    const assets = await import('~/server/services/blocks/app-listing-assets.service');
    vi.mocked(assets.resolveListingRatingFloorInTx).mockResolvedValueOnce('r');
    db.write.appListing.findFirst.mockImplementation(draftFor('apl_draft'));
    db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    expect(recordRatingChange).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // -------------------------------------------------------------------------
  // 🔴 OWNER SCOPE. The transition carries the draft's `userId` forward untouched, so
  // transitioning a draft owned by ANOTHER user would hand them ownership of this
  // submitter's approved listing (the asset procs gate on AppListing.userId).
  // -------------------------------------------------------------------------
  it('resolves the draft OWNER-SCOPED to the request submitter (a foreign draft is not transitioned)', async () => {
    db.write.appListing.findFirst.mockImplementation(draftFor('apl_draft'));
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    const draftProbe = db.write.appListing.findFirst.mock.calls
      .map((c) => (c[0] as { where?: Record<string, unknown> })?.where ?? {})
      .find((w) => w.status === 'draft' && w.appBlockId === null);
    expect(draftProbe).toBeDefined();
    // Scoped to the submitter (the fixture request's submittedByUserId) — a same-slug
    // draft owned by anyone else cannot match.
    expect(draftProbe!.userId).toBe(4242);
  });
});

/**
 * The moderator's pre-approve rating warning answers "which listing will this approve
 * re-rate" with the same two `where` builders. These pin that approveRequest's own reads
 * ARE those builders' output, so the warning cannot drift from the write.
 */
describe('approveRequest — its re-rate lookups are the shared where-builders', () => {
  const whereArgs = () =>
    db.write.appListing.findFirst.mock.calls.map(
      (c) => (c[0] as { where?: Record<string, unknown> })?.where ?? {}
    );

  it('the (3b-transition) draft lookup is draftTransitionWhere(request)', async () => {
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });
    expect(whereArgs()).toContainEqual(
      draftTransitionWhere({ slug: 'cool-app', submittedByUserId: 4242 })
    );
  });

  it('the (3b-reset) restore lookup is resetRestoreWhere(appBlockId)', async () => {
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });
    expect(whereArgs()).toContainEqual(resetRestoreWhere('apb_1'));
  });
});

/**
 * 🔴 PUBLISH FLOOR ON THE ON-SITE APPROVE (operator ruling 2026-10-30, "enforce + warn at
 * submit"). Every store listing needs an icon AND a cover before it goes live — on-site apps
 * too. Before this, `approveRequest` checked only that the listing's images had passed
 * scanning, so a media-less draft transitioned to `approved` and went live with placeholder
 * art. The refusal must land BEFORE anything is written or committed: the listing writes are
 * log-and-continue, so a refusal there would deploy the app and leave a log line.
 *
 * Fixture ids are pairwise distinct and distinct from every constant asserted.
 */
describe('approveRequest — on-site publish floor (icon + cover)', () => {
  /** A findFirst that answers ONE of approve's two go-live lookups with `row`. */
  function answer(which: 'draft' | 'reset', row: Record<string, unknown>) {
    return async (...a: unknown[]) => {
      const w = (a[0] as { where?: Record<string, unknown> } | undefined)?.where ?? {};
      if (which === 'draft' && w.status === 'draft' && w.appBlockId === null) return row;
      if (which === 'reset' && w.status === 'pending' && w.appBlockId === 'apb_1') return row;
      return null;
    };
  }

  async function expectRefusedBeforeAnyWrite(missing: string) {
    const forgejo = await import('~/server/services/blocks/forgejo.service');
    await expect(approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })).rejects.toThrow(
      `Cannot approve yet: the store listing this approve publishes has no ${missing}. Every listing needs an icon and a cover before it goes live — the developer adds them on the listing's Media tab, then you can approve.`
    );
    // Nothing written, committed or built.
    expect(db.write.appBlock.update).not.toHaveBeenCalled();
    expect(db.write.appBlock.create).not.toHaveBeenCalled();
    expect(db.write.oauthClient.update).not.toHaveBeenCalled();
    expect(db.write.appListing.updateMany).not.toHaveBeenCalled();
    expect(db.write.appBlockPublishRequest.update).not.toHaveBeenCalled();
    expect(forgejo.commitFiles).not.toHaveBeenCalled();
  }

  it('🔴 REFUSES a first approve whose draft has NO icon and NO cover', async () => {
    db.write.appListing.findFirst.mockImplementation(
      answer('draft', { id: 'apl_draft_bare', iconId: null, coverId: null })
    );
    await expectRefusedBeforeAnyWrite('icon or cover');
  });

  it('🔴 REFUSES when the draft has an icon but no cover', async () => {
    db.write.appListing.findFirst.mockImplementation(
      answer('draft', { id: 'apl_draft_icon', iconId: 31, coverId: null })
    );
    await expectRefusedBeforeAnyWrite('cover');
  });

  it('🔴 REFUSES when the draft has a cover but no icon', async () => {
    db.write.appListing.findFirst.mockImplementation(
      answer('draft', { id: 'apl_draft_cover', iconId: null, coverId: 47 })
    );
    await expectRefusedBeforeAnyWrite('icon');
  });

  /**
   * 🔴 The up-front read must SELECT iconId and coverId. The other cases here answer with a
   * row whatever `select` asks for, so they cannot see a dropped column; this one answers only
   * the selected columns. Without them the floor fails closed and every first approve is refused.
   */
  it('🔴 approves a draft that has both, through a lookup that returns only the selected columns', async () => {
    const draft = { id: 'apl_draft_ok', iconId: 41, coverId: 47 };
    db.write.appListing.findFirst.mockImplementation(
      async (args: { where?: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const row = await answer('draft', draft)(args);
        if (!row || !args?.select) return row;
        return Object.fromEntries(Object.entries(row).filter(([k]) => args.select![k]));
      }
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
  });

  it('🔴 a moderator RESET re-approve of an art-less listing is EXEMPT: it restores the listing AND un-suspends the app', async () => {
    // Operator decision 2026-10-31: the floor gates a listing's FIRST go-live (a draft that was
    // never live). A mod reset (`resetOnsiteListingToPending`) bounces a listing that already
    // went live and suspends its app; its re-approve must restore both even without art —
    // otherwise a pre-rule art-less listing reset by a moderator stays pending and its app
    // stays suspended until the developer adds art.
    db.write.appListing.findFirst.mockImplementation(
      answer('reset', { id: 'apl_reset_bare', iconId: 53, coverId: null, contentRating: 'pg' })
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
    // The restore (pending → approved) ran…
    const restore = db.write.appListing.updateMany.mock.calls.find((c) => {
      const a = c[0] as { where?: Record<string, unknown>; data?: Record<string, unknown> };
      return a?.where?.status === 'pending' && a?.data?.status === 'approved';
    });
    expect(restore).toBeDefined();
    // …and the app was un-suspended.
    expect(db.write.appBlock.updateMany).toHaveBeenCalledWith({
      where: { id: 'apb_1', status: 'suspended' },
      data: { status: 'approved' },
    });
  });

  describe('the re-approve after a late hold on a live app is cleared', () => {
    /**
     * One stored on-site listing, in the status the late-hold rollback left it
     * (publish-request.finaliseOnsiteApprove.test.ts pins which). Lookups and the reset flip
     * match it on their plain where-fields, as the database would.
     */
    function storedListing(status: string) {
      const row: Record<string, unknown> = {
        id: 'apl_live',
        status,
        kind: 'onsite',
        appBlockId: 'apb_1',
        iconId: 53,
        coverId: 47,
        contentRating: 'pg',
      };
      const matches = (where: Record<string, unknown> = {}) =>
        Object.entries(where).every(
          ([k, v]) => (v !== null && typeof v === 'object') || row[k] === v
        );
      db.read.appBlock.findFirst.mockResolvedValue({
        ...existingAppBlock(),
        currentVersionSha: 'a'.repeat(40),
      });
      db.write.appListing.findFirst.mockImplementation(async (...a: unknown[]) =>
        matches((a[0] as { where?: Record<string, unknown> } | undefined)?.where) ? row : null
      );
      db.write.appListing.updateMany.mockImplementation(async (...a: unknown[]) => {
        const args = a[0] as { where?: Record<string, unknown>; data?: object } | undefined;
        if (!matches(args?.where)) return { count: 0 };
        Object.assign(row, args?.data);
        return { count: 1 };
      });
      return row;
    }
    const unsuspend = {
      where: { id: 'apb_1', status: 'suspended' },
      data: { status: 'approved' },
    };

    it('🔴 a delisted app stays removed and suspended', async () => {
      const listing = storedListing('removed');
      await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });
      expect(listing.status).toBe('removed');
      expect(db.write.appBlock.updateMany).not.toHaveBeenCalledWith(unsuspend);
    });

    it('an app that was live publishes again and is un-suspended', async () => {
      const listing = storedListing('pending');
      await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });
      expect(listing.status).toBe('approved');
      expect(db.write.appBlock.updateMany).toHaveBeenCalledWith(unsuspend);
    });
  });

  describe('a first version re-approved after a late hold (its hold since cleared)', () => {
    /** A first version a late hold left: no current sha, and a late-resuspend on record. */
    function lateHeldFirstVersion({ late = true, currentVersionSha = null as string | null } = {}) {
      db.read.appBlock.findFirst.mockResolvedValue({ ...existingAppBlock(), currentVersionSha });
      db.write.$queryRaw.mockImplementation(async (strings: unknown) =>
        Array.isArray(strings) && strings.join('').includes('publishRequestHoldLateResuspend')
          ? [{ late }]
          : []
      );
      db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    }
    afterEach(() => {
      db.write.$queryRaw.mockImplementation(async () => []);
    });

    it('🔴 re-runs the floor: media now below it refuses, and the app stays suspended', async () => {
      lateHeldFirstVersion();
      db.write.appListing.findFirst.mockImplementation(
        answer('reset', { id: 'apl_held', iconId: 53, coverId: null, contentRating: 'pg' })
      );
      await expectRefusedBeforeAnyWrite('cover');
      expect(db.write.appBlock.updateMany).not.toHaveBeenCalled();
    });

    it('passes the floor with an icon and a cover, and un-suspends the app', async () => {
      lateHeldFirstVersion();
      db.write.appListing.findFirst.mockImplementation(
        answer('reset', { id: 'apl_held', iconId: 53, coverId: 47, contentRating: 'pg' })
      );
      await expect(
        approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
      ).resolves.toMatchObject({ publishRequestId: 'req_1' });
      expect(db.write.appBlock.updateMany).toHaveBeenCalledWith({
        where: { id: 'apb_1', status: 'suspended' },
        data: { status: 'approved' },
      });
    });

    it('a version that already went live stays exempt, late hold or not', async () => {
      lateHeldFirstVersion({ currentVersionSha: 'a'.repeat(40) });
      db.write.appListing.findFirst.mockImplementation(
        answer('reset', { id: 'apl_live', iconId: null, coverId: null, contentRating: 'pg' })
      );
      await expect(
        approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
      ).resolves.toMatchObject({ publishRequestId: 'req_1' });
    });
  });

  it('a reset re-approve with NO icon and NO cover is exempt too', async () => {
    db.write.appListing.findFirst.mockImplementation(
      answer('reset', { id: 'apl_reset_none', iconId: null, coverId: null, contentRating: 'g' })
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1' });
  });

  it('ALLOWS the reset restore when the listing has both', async () => {
    db.write.appListing.findFirst.mockImplementation(
      answer('reset', { id: 'apl_reset_ok', iconId: 53, coverId: 59, contentRating: 'pg' })
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
  });

  it('an UPDATE to an app whose listing is already live is NOT gated (no listing goes live), even art-less', async () => {
    // Neither go-live lookup matches: the listing is `approved` and keyed by appBlockId, so
    // the version approve only re-syncs its manifest copy. Refusing it would stall the app's
    // code fixes without taking anything off the store.
    db.write.appListing.findFirst.mockResolvedValue(null);
    db.read.appListing.findUnique.mockResolvedValue({ id: 'apl_live_bare', kind: 'onsite' });
    db.write.appListing.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1', appBlockId: 'apb_1' });
    expect(scalarSyncCalls()).toHaveLength(1);
  });
});

/**
 * 🔴 THE CHECK-THEN-PUBLISH WINDOW. The floor is checked up front, but the owner can edit the
 * draft until the transition writes. The transition's `where` requires both media columns, so
 * an icon removed in between makes it match 0 rows — and that 0-count must refuse the approve
 * exactly like the up-front check, not log-and-continue into a deploy with a stranded draft.
 */
describe('approveRequest — media removed between the floor check and the transition', () => {
  it('🔴 refuses with the floor message when the guarded transition matches 0 rows because the icon is gone', async () => {
    const forgejo = await import('~/server/services/blocks/forgejo.service');
    // Call 1 (up-front publishTarget): both present. Every later read: icon gone.
    const before = { id: 'apl_race', iconId: 91, coverId: 97 };
    const afterEdit = { id: 'apl_race', iconId: null, coverId: 97 };
    let draftReads = 0;
    db.write.appListing.findFirst.mockImplementation(
      async (args: { where?: Record<string, unknown> }) => {
        const w = args?.where ?? {};
        const isDraft = w.status === 'draft' && (w.appBlockId === null || w.id === 'apl_race');
        if (!isDraft) return null;
        draftReads += 1;
        return draftReads === 1 ? before : afterEdit;
      }
    );
    // The guarded write matches nothing: the row no longer has an icon.
    db.write.appListing.updateMany.mockResolvedValue({ count: 0 });

    await expect(approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })).rejects.toThrow(
      "Cannot approve yet: the store listing this approve publishes has no icon. Every listing needs an icon and a cover before it goes live — the developer adds them on the listing's Media tab, then you can approve."
    );
    // Refused before the commit/build and before the request is finalised.
    expect(forgejo.commitFiles).not.toHaveBeenCalled();
    expect(db.write.appBlockPublishRequest.update).not.toHaveBeenCalled();
  });

  it('a 0-row transition whose draft still has both (already approved / cleaned) does not refuse', async () => {
    db.write.appListing.findFirst.mockImplementation(
      async (args: { where?: Record<string, unknown> }) => {
        const w = args?.where ?? {};
        if (w.status === 'draft' && w.appBlockId === null)
          return { id: 'apl_gone', iconId: 91, coverId: 97 };
        // The re-read by id: the row is no longer a draft.
        return null;
      }
    );
    db.write.appListing.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).resolves.toMatchObject({ publishRequestId: 'req_1' });
    expect(db.write.appBlockPublishRequest.update).toHaveBeenCalledOnce();
  });
});

describe('approveRequest — a remix app row', () => {
  it.each(['remix', 'remix_disabled'])(
    '🔴 refuses a request on a slug whose row is a remix app (status %s), writing nothing',
    async (status) => {
      db.read.appBlock.findFirst.mockResolvedValue({ ...existingAppBlock(), status });
      const forgejo = await import('~/server/services/blocks/forgejo.service');

      await expect(
        approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
      ).rejects.toThrow('Cannot approve: cool-app is a remix app.');
      expect(db.write.appBlock.update).not.toHaveBeenCalled();
      expect(db.write.oauthClient.update).not.toHaveBeenCalled();
      expect(forgejo.commitFiles).not.toHaveBeenCalled();
    }
  );

  it('🔴 refuses when the status-guarded write matches nothing (P2025), re-capping and committing nothing', async () => {
    db.read.appBlock.findFirst.mockResolvedValue({ ...existingAppBlock(), status: 'approved' });
    // The row became a remix app after the guard read it: only the guarded write misses.
    db.write.appBlock.update.mockImplementation((async (a: { where?: { status?: unknown } }) => {
      if (a?.where?.status)
        throw new Prisma.PrismaClientKnownRequestError('No record was found for an update.', {
          code: 'P2025',
          clientVersion: 'test',
        });
      return {};
    }) as never);
    const forgejo = await import('~/server/services/blocks/forgejo.service');

    await expect(
      approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 })
    ).rejects.toMatchObject({ code: 'P2025' });
    expect(db.write.oauthClient.update).not.toHaveBeenCalled();
    expect(forgejo.commitFiles).not.toHaveBeenCalled();
  });

  it('CONTROL: the same request on an approved store app replaces its manifest', async () => {
    db.read.appBlock.findFirst.mockResolvedValue({ ...existingAppBlock(), status: 'approved' });

    await approveRequest({ publishRequestId: 'req_1', reviewerUserId: 9 });

    // The write re-checks the status the guard read: a row that became a remix app is not replaced.
    expect(db.write.appBlock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'apb_1', status: { notIn: ['remix', 'remix_disabled'] } },
        data: expect.objectContaining({ manifest: expect.anything() }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// App Storage `keyedBy` immutability at APPROVE (docs/app-storage-generic-core.md, "Viewer-keyed
// documents"): a push-originated request never passes `submitVersion`, so approve refuses it too,
// against EVERY earlier approval. The only approval that declared `votes` is the 51st newest,
// outside the capped schema-diff history, so only `baseline.approved` at the approve call site
// can see it. The storage-migration modules are real here.
// ---------------------------------------------------------------------------

const VK_SLUG = 'vote-board-4c2a';
const VK_NEW_MANIFEST = {
  name: 'Vote Board',
  scopes: ['apps:storage'],
  // Not `write: "none"` + counters: those are refused as new declarations (below).
  storage: { collections: { votes: { visibility: 'shared', write: 'own' } } },
};
const VK_ENFORCED = {
  name: 'Vote Board',
  scopes: ['apps:storage'],
  storage: { collections: { notes: { visibility: 'private' } } },
};
const VK_OLD_VOTES = {
  name: 'Vote Board',
  storage: { collections: { votes: { visibility: 'shared', write: 'own', keyedBy: 'viewer' } } },
};

function vkPendingRow(manifest: unknown = VK_NEW_MANIFEST) {
  return {
    id: 'req_vk',
    status: 'pending',
    slug: VK_SLUG,
    version: '3.0.0',
    manifest,
    bundleKey: 'bundles/vote-board.zip',
    forgejoCommitSha: '',
    submittedByUserId: 4243,
    appBlockId: 'apb_vk',
    deployState: null,
  };
}

const vkApprovals = (withOld: boolean) => [
  ...Array.from({ length: 50 }, (_, i) => ({ id: `pubreq_r${i}`, manifest: VK_ENFORCED })),
  ...(withOld ? [{ id: 'pubreq_old', manifest: VK_OLD_VOTES }] : []),
];

async function setupVkApprove(manifest: unknown) {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(manifest));
  zip.file('index.html', '<html></html>');
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
  db.read.appBlockPublishRequest.findUnique.mockResolvedValue(vkPendingRow(manifest));
  db.read.appBlock.findFirst.mockResolvedValue({
    id: 'apb_vk',
    appId: 'app_vk',
    repoUrl: 'https://forgejo.example/vote-board',
    trustTier: 'unverified',
    app: { allowedScopes: 0n, allowedOrigins: ['https://vote-board.apps.example'] },
  });
  // What the store enforces (the baseline): no `votes`.
  db.write.appBlock.findFirst.mockResolvedValue({ id: 'apb_vk', manifest: VK_ENFORCED });
  db.write.appBlock.findUnique.mockResolvedValue({
    id: 'apb_vk',
    blockId: VK_SLUG,
    manifest,
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
}

describe('approveRequest — keyedBy immutability against every approval', () => {
  let savedZip = holder.zipBytes;
  afterEach(() => {
    holder.zipBytes = savedZip;
  });
  beforeEach(async () => {
    savedZip = holder.zipBytes;
    await setupVkApprove(VK_NEW_MANIFEST);
  });

  it('🔴 refuses dropping keyedBy a 51st-newest approval declared, before the request is approved', async () => {
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(vkApprovals(true));
    await expect(approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 })).rejects.toThrow(
      'storage.collections.votes: an approved version declared it with keyedBy "viewer"'
    );
    // Nothing approved it: no request write sets status "approved", and no block was written.
    const approvedWrites = [
      ...db.write.appBlockPublishRequest.update.mock.calls,
      ...db.write.appBlockPublishRequest.updateMany.mock.calls,
    ].filter((c) => (c[0] as { data?: { status?: string } })?.data?.status === 'approved');
    expect(approvedWrites).toEqual([]);
    expect(db.write.appBlock.update).not.toHaveBeenCalled();
    expect(db.write.appBlock.create).not.toHaveBeenCalled();
    // The baseline read every approval: no cap on the query.
    const query = db.write.appBlockPublishRequest.findMany.mock.calls.at(-1)?.[0] as {
      take?: number;
    };
    expect(query.take).toBeUndefined();
  });

  it('positive control: without that approval the storage gate passes', async () => {
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(vkApprovals(false));
    const outcome = await approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 }).then(
      () => null,
      (err: Error) => err.message
    );
    // Whatever later step this stubbed harness reaches, it is not the keyedBy refusal.
    expect(outcome ?? '').not.toContain('keyedBy');
  });
});

// docs/app-storage-generic-core.md, rollout step 3, at APPROVE: a push-originated request never
// passes `submitVersion`, so approve refuses a NEW mark, counter or `write: "none"` too, against
// what the store enforces. The storage-migration modules are real here.
describe('approveRequest — removed marks, counters and write "none"', () => {
  const withVotes = (votes: Record<string, unknown>) => ({
    ...VK_NEW_MANIFEST,
    storage: { collections: { notes: { visibility: 'private' }, votes } },
  });
  let savedZip = holder.zipBytes;
  afterEach(() => {
    holder.zipBytes = savedZip;
  });
  beforeEach(() => {
    savedZip = holder.zipBytes;
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(vkApprovals(false));
  });
  const outcomeOf = async (manifest: unknown) => {
    await setupVkApprove(manifest);
    return approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 }).then(
      () => null,
      (err: Error) => err.message
    );
  };

  it('🔴 refuses a new write "none" counter collection, before the request is approved', async () => {
    const outcome = await outcomeOf(
      withVotes({ visibility: 'shared', write: 'none', counters: ['n'] })
    );
    expect(outcome).toContain(
      'storage.collections.votes.write: "none" is not declared on this collection by the previous approved version, and write "none" was removed'
    );
    expect(outcome).toContain(
      'storage.collections.votes.counters: "n" is not declared on this collection by the previous approved version, and counters were removed'
    );
    const approvedWrites = [
      ...db.write.appBlockPublishRequest.update.mock.calls,
      ...db.write.appBlockPublishRequest.updateMany.mock.calls,
    ].filter((c) => (c[0] as { data?: { status?: string } })?.data?.status === 'approved');
    expect(approvedWrites).toEqual([]);
    expect(db.write.appBlock.update).not.toHaveBeenCalled();
  });

  it('positive control: a collection the enforced manifest declares with the same mark passes the gate', async () => {
    await setupVkApprove(withVotes({ visibility: 'shared', write: 'own', marks: ['vote'] }));
    // The enforced manifest declares `votes` with the same mark. It differs from the request in
    // `showAuthor`, so the baseline is read as an earlier version, not as this approve's own write
    // (`loadStorageMigrationBaseline`'s `selfManifest`).
    db.write.appBlock.findFirst.mockResolvedValue({
      id: 'apb_vk',
      manifest: withVotes({
        visibility: 'shared',
        write: 'own',
        marks: ['vote'],
        showAuthor: true,
      }),
    });
    const outcome = await approveRequest({ publishRequestId: 'req_vk', reviewerUserId: 9 }).then(
      () => null,
      (err: Error) => err.message
    );
    // Whatever later step this stubbed harness reaches, it is not the removed-primitive refusal.
    expect(outcome ?? '').not.toContain('were removed');
  });
});
