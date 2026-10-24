import JSZip from 'jszip';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingAssets from '~/server/services/blocks/app-listing-assets.service';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
import type { ListingMediaSplitDecision } from '~/shared/utils/listing-media-split';
import { dbMock } from '~/__tests__/mocks/db.mock';

const db = { read: dbMock.dbRead, write: dbMock.dbWrite };

/**
 * T6 for on-site `approveRequest`: the (3b-transition) first approve of a pre-approval draft
 * and the (3b-reset) re-approve of a reset listing, with the moderator's media-split decision.
 * The decision is written to and read from a real `app_listing_red_media` (PGlite, the real
 * migration); the rating floor is the real `resolveListingRatingFloorInTx`. Harness mocks as in
 * `publish-request.listingSync.test.ts`.
 *
 * Fixture: the manifest declares `g`; the listing's icon and cover are PG, its screenshot R.
 */

const { s3, holder } = vi.hoisted(() => {
  const holder: { zipBytes: Uint8Array } = { zipBytes: new Uint8Array() };
  const s3 = {
    send: vi.fn(async () => ({
      Body: { transformToByteArray: async () => holder.zipBytes },
    })),
  };
  return { s3, holder };
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
// The scan-clean gate is a no-op here; the RATING FLOOR is the real one, so the split
// decision reaches it through the code under test.
vi.mock('~/server/services/blocks/app-listing-assets.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingAssets>()),
  assertListingAssetsScanCleanInTx: vi.fn(async () => undefined),
}));

const { approveRequest } = await import('~/server/services/blocks/publish-request.service');
const { commitFiles } = await import('~/server/services/blocks/forgejo.service');
const { triggerBuild } = await import('~/server/services/blocks/apps-pipeline.service');
const { NsfwLevel } = await import('~/server/common/enums');
const { MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE, MEDIA_SPLIT_UNAVAILABLE_MESSAGE } = await import(
  '~/server/services/blocks/listing-media-split.service'
);
const { createSplitDb } = await import('./listing-media-split.harness');

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const MANIFEST = { name: 'Cool App', scopes: [], contentRating: 'g' };
const MOD = 9;
const DRAFT = 'apl_draft';
const RESET = 'apl_reset';
const ICON = 21;
const COVER = 22;
const SHOT = 23;
const R_COVER = 24;
const LEVELS: Record<number, number> = {
  [ICON]: NsfwLevel.PG,
  [COVER]: NsfwLevel.PG,
  [SHOT]: NsfwLevel.R,
  [R_COVER]: NsfwLevel.R,
};

let split: Awaited<ReturnType<typeof createSplitDb>>;

beforeAll(async () => {
  const zip = new JSZip();
  zip.file('block.manifest.json', JSON.stringify(MANIFEST));
  zip.file('index.html', '<html></html>');
  holder.zipBytes = await zip.generateAsync({ type: 'uint8array' });
  split = await createSplitDb();
});
afterAll(async () => {
  await split.db.close();
  vi.restoreAllMocks();
});

async function resetSplitTable(present: boolean) {
  await split.unrestrict();
  await split.db.exec(`DROP TABLE IF EXISTS app_listing_red_media`);
  await split.db.exec(`TRUNCATE app_listings, "Image", "User" CASCADE`);
  if (present) await split.applyMigration();
  await split.seed({ listingIds: [DRAFT, RESET], images: LEVELS, users: [MOD] });
  split.route(db.write as never);
}

/** Which go-live the approve performs: the draft transition, or the reset restore. */
function wire(target: 'draft' | 'reset', coverId = COVER) {
  const row = { id: target === 'draft' ? DRAFT : RESET, iconId: ICON, coverId, contentRating: 'g' };
  db.write.appListing.findFirst.mockImplementation((async (args: {
    where?: Record<string, unknown>;
  }) => {
    const w = args?.where ?? {};
    if (target === 'draft' && w.status === 'draft' && w.appBlockId === null) return row;
    if (target === 'reset' && w.status === 'pending' && w.appBlockId === 'apb_1') return row;
    return null;
  }) as never);
  db.write.appListing.findUnique.mockImplementation((async (args: { where?: { id?: string } }) =>
    args?.where?.id === row.id ? { iconId: ICON, coverId } : null) as never);
  db.write.appListingScreenshot.findMany.mockResolvedValue([{ imageId: SHOT }]);
  db.write.image.findMany.mockImplementation((async (args: {
    where?: { id?: { in?: number[] } };
  }) =>
    (args?.where?.id?.in ?? []).map((id) => ({
      id,
      nsfwLevel: LEVELS[id] ?? NsfwLevel.PG,
    }))) as never);
}

/** The rating the go-live wrote: the transition (carries appBlockId) or the restore (status only). */
function stampedRating(target: 'draft' | 'reset'): unknown {
  const call = db.write.appListing.updateMany.mock.calls.find((c) => {
    const a = c[0] as { where?: { id?: unknown }; data?: Record<string, unknown> };
    return target === 'draft'
      ? a?.data != null && 'appBlockId' in a.data
      : a?.data?.status === 'approved' && a?.where?.id === undefined;
  });
  return (call?.[0] as { data?: { contentRating?: unknown } } | undefined)?.data?.contentRating;
}

const approve = (mediaSplit?: ListingMediaSplitDecision) =>
  approveRequest({ publishRequestId: 'req_1', reviewerUserId: MOD, mediaSplit });

beforeEach(async () => {
  vi.clearAllMocks();
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
  db.write.appBlock.updateMany.mockResolvedValue({ count: 0 });
  db.write.appBlock.findUnique.mockResolvedValue({
    id: 'apb_1',
    blockId: 'cool-app',
    manifest: MANIFEST,
    contentRating: 'g',
    category: 'utility',
    featured: false,
    featuredOrder: null,
    externalUrl: null,
    app: { userId: 42 },
  });
  db.write.oauthClient.update.mockResolvedValue({});
  db.write.appListing.create.mockResolvedValue({ id: 'apl_created' });
  db.write.appListing.updateMany.mockResolvedValue({ count: 1 });
  db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
    id: 'req_1',
    status: 'pending',
    slug: 'cool-app',
    version: '1.2.0',
    manifest: MANIFEST,
    bundleKey: 'bundles/cool-app.zip',
    forgejoCommitSha: '',
    submittedByUserId: 4242,
    appBlockId: 'apb_1',
    deployState: null,
  });
  db.read.appBlock.findFirst.mockResolvedValue({
    id: 'apb_1',
    appId: 'app_1',
    repoUrl: 'https://forgejo.example/cool-app',
    trustTier: 'unverified',
    app: { allowedScopes: 0, allowedOrigins: ['https://cool-app.apps.example'] },
  });
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
  await resetSplitTable(true);
});

describe.each([
  { go: '(3b-transition) first approve of the draft', target: 'draft' as const, id: DRAFT },
  { go: '(3b-reset) re-approve of a reset listing', target: 'reset' as const, id: RESET },
])('approveRequest $go', ({ target, id }) => {
  it('🔴 a split approve keeps the listing at its civitai.com rating and records the decision', async () => {
    wire(target);
    await approve('split');
    expect(stampedRating(target)).toBe('g');
    expect(await split.stamp(id)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('invariant guard: with the decision omitted the R screenshot still floors the listing', async () => {
    wire(target);
    await approve();
    expect(stampedRating(target)).toBe('r');
    expect(await split.stamp(id)).toBeNull();
  });

  it('🔴 a split with an above-SFW cover is refused before anything is committed or built', async () => {
    wire(target, R_COVER);
    await expect(approve('split')).rejects.toThrow(MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(stampedRating(target)).toBeUndefined();
  });

  it('🔴 table absent: a split is refused as unavailable before anything is committed', async () => {
    await resetSplitTable(false);
    wire(target);
    await expect(approve('split')).rejects.toThrow(MEDIA_SPLIT_UNAVAILABLE_MESSAGE);
    expect(commitFiles).not.toHaveBeenCalled();
  });

  it('table absent: an approve without a decision floors exactly as before', async () => {
    await resetSplitTable(false);
    wire(target);
    await approve();
    expect(stampedRating(target)).toBe('r');
  });

  // The table present but not granted to the role the app writes with (`SET ROLE` on PGlite).
  // The go-live writes below the pre-flight LOG AND CONTINUE, so without the pre-flight this
  // deployed the app with the listing left `draft`, or `pending` with the block `suspended`.
  const NOT_WRITABLE = /not permitted to update it/;
  const unsuspended = () =>
    db.write.appBlock.updateMany.mock.calls.some(
      (c) => (c[0] as { data?: { status?: string } })?.data?.status === 'approved'
    );

  /** A split stamped by the owning role, which the restricted role may not be able to see. */
  const stampAsOwner = () =>
    split.db.query(
      `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
       VALUES ($1, now(), $2)`,
      [id, MOD]
    );
  /** Statements the approve issued against the split table itself (the probe names it only as a string). */
  const tableStatements = () =>
    [...db.write.$queryRaw.mock.calls, ...db.write.$executeRaw.mock.calls]
      .map((c) => Prisma.sql(c[0] as TemplateStringsArray, ...(c.slice(1) as unknown[])).text)
      .filter((sql) => sql.includes('app_listing_red_media') && !sql.includes('to_regclass'));

  it('🔴 present but unreadable: an approve with NO decision goes live as before, issuing nothing against the table', async () => {
    // Operator decision (2026-10-18): a role that cannot read the table has nothing to clear
    // that it can see, so the approve is the one it was before the split existed.
    await stampAsOwner();
    await split.restrictTo([]);
    wire(target);
    await approve();
    expect(commitFiles).toHaveBeenCalled();
    expect(triggerBuild).toHaveBeenCalled();
    expect(stampedRating(target)).toBe('r');
    expect(tableStatements()).toEqual([]);
    // The stamp it could not see is left exactly as it was (the accepted limitation).
    expect(await split.stamp(id)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('🔴 present but unreadable: an EXPLICIT decision is refused before anything is committed or flipped', async () => {
    await split.restrictTo([]);
    wire(target);
    for (const decision of ['split', 'rate-mature'] as const) {
      await expect(approve(decision)).rejects.toThrow(NOT_WRITABLE);
      expect(commitFiles).not.toHaveBeenCalled();
      expect(stampedRating(target)).toBeUndefined();
      expect(unsuspended()).toBe(false);
    }
  });

  it('🔴 read-only and the listing IS split: an approve with NO decision is refused, the stamp kept', async () => {
    await stampAsOwner();
    await split.restrictTo(['SELECT']);
    wire(target);
    await expect(approve()).rejects.toThrow(NOT_WRITABLE);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(stampedRating(target)).toBeUndefined();
    expect(await split.stamp(id)).toEqual({ at: expect.any(String), by: MOD });
    // Positive control for `tableStatements`: this approve did read the table.
    expect(tableStatements().length).toBeGreaterThan(0);
  });

  it('🔴 present but read-only: a split is refused as not writable before anything is committed', async () => {
    await split.restrictTo(['SELECT']);
    wire(target);
    await expect(approve('split')).rejects.toThrow(NOT_WRITABLE);
    expect(commitFiles).not.toHaveBeenCalled();
    expect(stampedRating(target)).toBeUndefined();
  });

  it('🔴 present but read-only with nothing to clear: an approve without a decision goes live as before', async () => {
    await split.restrictTo(['SELECT']);
    wire(target);
    await approve();
    expect(stampedRating(target)).toBe('r');
  });

  it('positive control: granted SELECT, INSERT and UPDATE, the same role approves a split', async () => {
    await split.restrictTo(['SELECT', 'INSERT', 'UPDATE']);
    wire(target);
    await approve('split');
    expect(stampedRating(target)).toBe('g');
    expect(await split.stamp(id)).toEqual({ at: expect.any(String), by: MOD });
  });
});

describe('approveRequest — the go-live re-checks the face the up-front check saw', () => {
  it('🔴 a cover swapped to R after the up-front check is refused at the go-live, not split', async () => {
    wire('draft');
    const first = { id: DRAFT, iconId: ICON, coverId: COVER, contentRating: 'g' };
    const swapped = { ...first, coverId: R_COVER };
    db.write.appListing.findFirst
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(swapped as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await approve('split');
      expect(await split.stamp(DRAFT)).toBeNull();
      expect(stampedRating('draft')).toBeUndefined();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        MEDIA_SPLIT_FACE_NOT_SFW_MESSAGE
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('approveRequest with no store listing to publish', () => {
  it('refuses a split, since there is nothing to split', async () => {
    db.write.appListing.findFirst.mockResolvedValue(null);
    await expect(approve('split')).rejects.toThrow(/publishes no store listing/);
    expect(commitFiles).not.toHaveBeenCalled();
  });
});
