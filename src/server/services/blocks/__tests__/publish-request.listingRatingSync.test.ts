import JSZip from 'jszip';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AppListingAssets from '~/server/services/blocks/app-listing-assets.service';
import type * as AppListingRating from '~/server/services/blocks/app-listing-rating';
import type * as VersionRating from '~/server/services/blocks/app-listing-version-rating.service';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as AppDeveloperTermsService from '~/server/services/blocks/app-developer-terms.service';

vi.mock('~/server/services/blocks/app-developer-terms.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppDeveloperTermsService>()),
  hasAcceptedAppDeveloperTerms: vi.fn(async () => true),
  assertAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertAcceptedAppDeveloperTermsTrpc: vi.fn(async () => undefined),
  assertOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
  assertListingOwnerAcceptedAppDeveloperTerms: vi.fn(async () => undefined),
}));

const db = { read: dbMock.dbRead, write: dbMock.dbWrite };

/**
 * `approveRequest` on a SUBSEQUENT version of an app whose on-site listing already exists
 * ((3b-sync)): the listing's `contentRating` is re-set to the approved manifest's declared
 * rating, raised to its store media's rating when that is more mature. It may LOWER.
 *
 * The listings live in an in-memory table the mocked `appListing` delegate filters on its
 * plain `where` fields, as the database would, so "which row was rewritten" is observed on the
 * rows rather than read off a call's arguments. The rating floor is the real
 * `resolveListingRatingFloorInTx`, and the media split is read from a real
 * `app_listing_red_media` (PGlite, the real migration). Harness as in
 * `listing-media-split.approve-request.test.ts`.
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

vi.mock('~/server/utils/cache-helpers', () => ({
  queryCache: () => async (): Promise<unknown[]> => [],
  bustCacheTag: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/blocks/app-block-notify', () => ({
  notifyAppBlockSubmitter: vi.fn(async () => undefined),
}));
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
// The real rule, watched: the approve and the moderator re-sync must both go through it.
const { versionRatingSpy } = vi.hoisted(() => ({ versionRatingSpy: vi.fn() }));
vi.mock('~/server/services/blocks/app-listing-version-rating.service', async (importOriginal) => {
  const real = await importOriginal<typeof VersionRating>();
  return {
    ...real,
    resolveVersionListingRating: (...a: Parameters<typeof real.resolveVersionListingRating>) => {
      versionRatingSpy(...a);
      return real.resolveVersionListingRating(...a);
    },
  };
});
// The scan-clean gate is a no-op here; the RATING FLOOR is the real one.
vi.mock('~/server/services/blocks/app-listing-assets.service', async (importOriginal) => ({
  ...(await importOriginal<typeof AppListingAssets>()),
  assertListingAssetsScanCleanInTx: vi.fn(async () => undefined),
}));

const {
  approveRequest,
  previewVersionListingRating,
  previewListingRatingResync,
  resyncListingRating,
} = await import('~/server/services/blocks/publish-request.service');
const { NsfwLevel } = await import('~/server/common/enums');
const { createSplitDb } = await import('./listing-media-split.harness');

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

/** The new version declares `pg13`. Unless a case says otherwise the previous one declared `x`. */
const MANIFEST = { name: 'Cool App', scopes: [], contentRating: 'pg13' };
const MOD = 9;
const LIVE = 'apl_live';
const SHADOW = 'apl_shadow';
const ICON = 21;
const COVER = 22;
const SHOT_R = 23;
const LEVELS: Record<number, number> = {
  [ICON]: NsfwLevel.PG,
  [COVER]: NsfwLevel.PG,
  [SHOT_R]: NsfwLevel.R,
};

type Row = Record<string, unknown> & { id: string; contentRating: string | null };
let rows: Row[] = [];
let screenshots: Record<string, number[]> = {};
/** The app's rating before this approve: the previous version's declaration. */
let previousDeclared = 'x';

/** Plain-valued `where` fields must equal the row's; relation / operator filters are ignored. */
const matches = (row: Row, where: Record<string, unknown> = {}) =>
  Object.entries(where).every(([k, v]) => (v !== null && typeof v === 'object') || row[k] === v);
/** A COPY of the matching row, as a database read returns: a later write must not reach it. */
const find = (where?: Record<string, unknown>) => {
  const hit = rows.find((r) => matches(r, where));
  return hit ? { ...hit } : null;
};
const row = (id: string) => rows.find((r) => r.id === id)!;

function seedListings(
  opts: { kind?: 'onsite' | 'offsite'; withShadow?: boolean; rating?: string } = {}
) {
  rows = [
    {
      id: LIVE,
      kind: opts.kind ?? 'onsite',
      slug: 'cool-app',
      status: 'approved',
      appBlockId: 'apb_1',
      revisionOfId: null,
      userId: 4242,
      iconId: ICON,
      coverId: COVER,
      contentRating: opts.rating ?? 'x',
    },
  ];
  // A live media revision in flight: a shadow row of the same listing. Its appBlockId is NULL,
  // as `beginListingRevision` leaves it, and it was opened at the live rating.
  if (opts.withShadow)
    rows.push({
      id: SHADOW,
      kind: 'onsite',
      slug: 'rev-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      status: 'pending',
      appBlockId: null,
      revisionOfId: LIVE,
      userId: 4242,
      iconId: ICON,
      coverId: COVER,
      contentRating: 'x',
    });
}

function wireListingTable() {
  const findUnique = (async (args: { where?: Record<string, unknown> }) =>
    find(args?.where)) as never;
  db.read.appListing.findUnique.mockImplementation(findUnique);
  db.write.appListing.findUnique.mockImplementation(findUnique);
  const findFirst = (async (args: { where?: Record<string, unknown> }) =>
    find(args?.where)) as never;
  db.read.appListing.findFirst.mockImplementation(findFirst);
  db.write.appListing.findFirst.mockImplementation(findFirst);
  db.write.appListing.updateMany.mockImplementation((async (args: {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) => {
    const hit = rows.filter((r) => matches(r, args?.where));
    for (const r of hit) Object.assign(r, args?.data);
    return { count: hit.length };
  }) as never);
  db.write.appListing.update.mockImplementation((async (args: {
    where?: Record<string, unknown>;
    data?: Record<string, unknown>;
  }) => {
    const r = rows.find((x) => matches(x, args?.where));
    if (r) Object.assign(r, args?.data);
    return r ? { ...r } : null;
  }) as never);
  // The approve floors on the primary, the approve-bar preview on the replica: both see the
  // same media.
  for (const client of [db.read, db.write]) {
    client.appListingScreenshot.findMany.mockImplementation((async (args: {
      where?: { appListingId?: string };
    }) =>
      (screenshots[args?.where?.appListingId ?? ''] ?? []).map((imageId) => ({
        imageId,
      }))) as never);
    client.image.findMany.mockImplementation((async (args: {
      where?: { id?: { in?: number[] } };
    }) =>
      (args?.where?.id?.in ?? []).map((id) => ({
        id,
        nsfwLevel: LEVELS[id] ?? NsfwLevel.PG,
      }))) as never);
  }
}

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

const approve = () => approveRequest({ publishRequestId: 'req_1', reviewerUserId: MOD });

beforeEach(async () => {
  vi.clearAllMocks();
  screenshots = {};
  previousDeclared = 'x';
  db.read.appBlockPublishRequest.findMany.mockResolvedValue([] as never);
  db.write.appBlockPublishRequest.findMany.mockResolvedValue([] as never);
  db.write.appBlockPublishRequest.update.mockImplementation(
    async (a: { data?: unknown }) => a?.data ?? {}
  );
  db.write.appBlockPublishRequest.updateMany.mockResolvedValue({ count: 1 });
  db.write.appBlock.update.mockImplementation(async (a: { data?: unknown }) => a?.data ?? {});
  db.write.appBlock.updateMany.mockResolvedValue({ count: 0 });
  // The block as the approve reads it on the primary: the rollback snapshot taken BEFORE the
  // version update (it selects `approvedScopes`) carries the previous declaration, every later
  // read the new manifest's.
  db.write.appBlock.findUnique.mockImplementation((async (args: {
    select?: Record<string, unknown>;
  }) =>
    args?.select?.approvedScopes
      ? {
          manifest: { ...MANIFEST, contentRating: previousDeclared },
          version: '1.2.0',
          approvedScopes: [],
          contentRating: previousDeclared,
          renderMode: 'iframe',
          trustTier: 'unverified',
        }
      : {
          id: 'apb_1',
          blockId: 'cool-app',
          manifest: MANIFEST,
          contentRating: 'pg13',
          category: 'utility',
          featured: false,
          featuredOrder: null,
          externalUrl: null,
          app: { userId: 42 },
        }) as never);
  // Before the approve runs, the replica still has the previous version's rating.
  db.read.appBlock.findUnique.mockImplementation((async () => ({
    contentRating: previousDeclared,
  })) as never);
  db.write.oauthClient.update.mockResolvedValue({});
  db.write.oauthClient.findUnique.mockResolvedValue({ allowedScopes: 0n });
  db.read.appBlockPublishRequest.findUnique.mockResolvedValue({
    id: 'req_1',
    status: 'pending',
    slug: 'cool-app',
    version: '1.3.0',
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
    currentVersionSha: 'a'.repeat(40),
    app: { allowedScopes: 0n, allowedOrigins: ['https://cool-app.apps.example'] },
  });
  s3.send.mockImplementation(async () => ({
    Body: { transformToByteArray: async () => holder.zipBytes },
  }));
  await split.unrestrict();
  await split.db.exec(`DROP TABLE IF EXISTS app_listing_red_media`);
  await split.db.exec(`TRUNCATE app_listings, "Image", "User" CASCADE`);
  await split.applyMigration();
  await split.seed({ listingIds: [LIVE, SHADOW], images: LEVELS, users: [MOD] });
  split.route(db.write as never);
  split.route(db.read as never);
  wireListingTable();
});

describe('approveRequest (3b-sync) — the listing rating follows the approved manifest', () => {
  it('🔴 LOWERS an `x` listing to the new version’s `pg13` when its store art is tame', async () => {
    seedListings();
    await approve();
    expect(row(LIVE).contentRating).toBe('pg13');
    expect(recordRatingChange).toHaveBeenCalledWith({
      appListingId: LIVE,
      slug: 'cool-app',
      before: 'x',
      after: 'pg13',
      actorUserId: MOD,
    });
    expect(recordRatingChange).toHaveBeenCalledTimes(1);
  });

  it('🔴 a `pg13` declaration over mature store art takes the art’s rating', async () => {
    seedListings();
    screenshots[LIVE] = [SHOT_R];
    await approve();
    expect(row(LIVE).contentRating).toBe('r');
  });

  it('🔴 keeps a media split a moderator granted: the R screenshot does not floor it', async () => {
    seedListings();
    screenshots[LIVE] = [SHOT_R];
    await split.db.query(
      `INSERT INTO app_listing_red_media (app_listing_id, media_split_approved_at, media_split_approved_by)
       VALUES ($1, now(), $2)`,
      [LIVE, MOD]
    );
    await approve();
    expect(row(LIVE).contentRating).toBe('pg13');
    // The approve published no listing, so it decided nothing about the split.
    expect(await split.stamp(LIVE)).toEqual({ at: expect.any(String), by: MOD });
  });

  it('🔴 KEEPS a moderator’s raise: a `pg13` app whose listing a moderator raised to `r` stays `r`', async () => {
    previousDeclared = 'pg13';
    seedListings({ rating: 'r' });
    await approve();
    expect(row(LIVE).contentRating).toBe('r');
    expect(recordRatingChange).not.toHaveBeenCalled();
  });

  it('🔴 an approve heals a listing stuck at `x` behind an earlier `pg13` approve', async () => {
    // v1 declared x, v2 declared pg13 and was approved before the sync existed; now v3 (pg13).
    previousDeclared = 'pg13';
    seedListings({ rating: 'x' });
    db.write.appBlockPublishRequest.findMany.mockResolvedValue(
      ['pg13', 'x'].map((r) => ({ manifest: { ...MANIFEST, contentRating: r } })) as never
    );
    await approve();
    expect(row(LIVE).contentRating).toBe('pg13');
  });

  it('a kept raise still rises with the app: the same listing goes to `x` when the version declares it', async () => {
    previousDeclared = 'pg13';
    seedListings({ rating: 'r' });
    db.write.appBlock.findUnique.mockImplementation((async (args: {
      select?: Record<string, unknown>;
    }) =>
      args?.select?.approvedScopes
        ? { contentRating: 'pg13', manifest: MANIFEST, version: '1.2.0', approvedScopes: [] }
        : {
            id: 'apb_1',
            blockId: 'cool-app',
            manifest: { ...MANIFEST, contentRating: 'x' },
            contentRating: 'x',
            category: 'utility',
            app: { userId: 42 },
          }) as never);
    await approve();
    expect(row(LIVE).contentRating).toBe('x');
  });

  // Invariant guard, not regression coverage: the re-sync was keyed on appBlockId before.
  it('leaves a shadow revision of the listing alone', async () => {
    seedListings({ withShadow: true });
    await approve();
    // Positive control: the re-sync ran, on the live row.
    expect(row(LIVE).name).toBe('Cool App');
    expect(row(SHADOW).contentRating).toBe('x');
    expect(row(SHADOW).name).toBeUndefined();
  });

  // Invariant guard: an off-site listing's copy and rating are its author's and its review's.
  it('leaves an off-site listing alone', async () => {
    seedListings({ kind: 'offsite' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await approve();
    } finally {
      warn.mockRestore();
    }
    expect(row(LIVE).contentRating).toBe('x');
    expect(recordRatingChange).not.toHaveBeenCalled();
  });
});

describe('previewVersionListingRating — what the approve bar shows the moderator', () => {
  it('🔴 shows the re-rate the approve then writes: X → PG-13', async () => {
    seedListings();
    expect(await previewVersionListingRating('req_1')).toEqual({
      listingId: LIVE,
      from: 'x',
      to: 'pg13',
    });
    await approve();
    expect(row(LIVE).contentRating).toBe('pg13');
  });

  it('a kept moderator raise previews as no change, and the approve keeps it', async () => {
    previousDeclared = 'pg13';
    seedListings({ rating: 'r' });
    expect(await previewVersionListingRating('req_1')).toEqual({
      listingId: LIVE,
      from: 'r',
      to: 'r',
    });
    await approve();
    expect(row(LIVE).contentRating).toBe('r');
  });

  it('mature store art previews the art’s rating', async () => {
    seedListings();
    screenshots[LIVE] = [SHOT_R];
    expect(await previewVersionListingRating('req_1')).toEqual({
      listingId: LIVE,
      from: 'x',
      to: 'r',
    });
  });

  it('nothing to re-rate: an off-site listing, or a request that is not pending', async () => {
    seedListings({ kind: 'offsite' });
    expect(await previewVersionListingRating('req_1')).toBeNull();
    seedListings();
    db.read.appBlockPublishRequest.findUnique.mockResolvedValueOnce({
      status: 'approved',
      appBlockId: 'apb_1',
      manifest: MANIFEST,
    } as never);
    expect(await previewVersionListingRating('req_1')).toBeNull();
  });
});

/**
 * The moderator action that re-runs the sync for an app approved before it existed. The app is
 * live at its current version (`pg13`); the approved versions are read newest first.
 */
describe('resyncListingRating — the moderator re-sync of one approved listing', () => {
  function approvedApp(versions: string[]) {
    for (const client of [db.read, db.write]) {
      client.appBlock.findUnique.mockImplementation((async () => ({
        status: 'approved',
        contentRating: versions[0],
      })) as never);
      client.appBlockPublishRequest.findMany.mockResolvedValue(
        versions.map((r) => ({ manifest: { ...MANIFEST, contentRating: r } })) as never
      );
    }
  }
  const resync = () => resyncListingRating({ appBlockId: 'apb_1', actorUserId: MOD });

  it('🔴 re-rates an `x` listing whose current version declares `pg13`, as the approve would, and records it', async () => {
    seedListings();
    approvedApp(['pg13', 'x']);
    const preview = await previewListingRatingResync('apb_1');
    expect(preview).toEqual({ listingId: LIVE, from: 'x', to: 'pg13' });
    expect(await resync()).toEqual({ listingId: LIVE, from: 'x', to: 'pg13', changed: true });
    // The preview and the write agree.
    expect(row(LIVE).contentRating).toBe(preview!.to);
    expect(recordRatingChange).toHaveBeenCalledTimes(1);
    expect(recordRatingChange).toHaveBeenCalledWith({
      appListingId: LIVE,
      slug: 'cool-app',
      before: 'x',
      after: 'pg13',
      actorUserId: MOD,
    });
  });

  it('uses the approve’s own rule: both go through resolveVersionListingRating', async () => {
    seedListings();
    await approve();
    expect(versionRatingSpy).toHaveBeenCalledTimes(1);
    expect(versionRatingSpy.mock.calls[0][1]).toEqual({
      appListingId: LIVE,
      current: 'x',
      earlierDeclared: ['x'],
      nextDeclared: 'pg13',
    });
    seedListings();
    approvedApp(['pg13', 'x']);
    versionRatingSpy.mockClear();
    await resync();
    expect(versionRatingSpy).toHaveBeenCalledTimes(1);
    expect(versionRatingSpy.mock.calls[0][1]).toEqual({
      appListingId: LIVE,
      current: 'x',
      earlierDeclared: ['pg13', 'pg13', 'x'],
      nextDeclared: 'pg13',
    });
  });

  it('🔴 heals a listing stuck at `x` behind more than one later version (x, pg13, pg13)', async () => {
    seedListings();
    approvedApp(['pg13', 'pg13', 'x']);
    expect(await previewListingRatingResync('apb_1')).toEqual({
      listingId: LIVE,
      from: 'x',
      to: 'pg13',
    });
    expect(await resync()).toMatchObject({ from: 'x', to: 'pg13', changed: true });
  });

  it('keeps a moderator’s raise: an `r` listing on a `pg13` app is left as it is', async () => {
    seedListings({ rating: 'r' });
    approvedApp(['pg13', 'pg13']);
    expect(await previewListingRatingResync('apb_1')).toEqual({
      listingId: LIVE,
      from: 'r',
      to: 'r',
    });
    expect(await resync()).toEqual({ listingId: LIVE, from: 'r', to: 'r', changed: false });
    expect(row(LIVE).contentRating).toBe('r');
    expect(recordRatingChange).not.toHaveBeenCalled();
  });

  it('a first version is its own previous version', async () => {
    seedListings({ rating: 'x' });
    approvedApp(['x']);
    expect(await resync()).toMatchObject({ from: 'x', to: 'x', changed: false });
  });

  it('refuses, writing nothing, when the rating moved between the read and the write', async () => {
    // The re-sync reads `x`; by the time it writes, a moderator has set the row to `r`.
    seedListings({ rating: 'r' });
    approvedApp(['pg13', 'x']);
    db.write.appListing.findFirst.mockImplementationOnce((async () => ({
      id: LIVE,
      slug: 'cool-app',
      contentRating: 'x',
    })) as never);
    await expect(resync()).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(row(LIVE).contentRating).toBe('r');
    expect(recordRatingChange).not.toHaveBeenCalled();
  });

  it('NOT_FOUND for an app with no approved on-site listing, or an app that is not approved', async () => {
    seedListings({ kind: 'offsite' });
    approvedApp(['pg13', 'x']);
    await expect(resync()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await previewListingRatingResync('apb_1')).toBeNull();
    seedListings();
    db.write.appBlock.findUnique.mockImplementation((async () => ({
      status: 'suspended',
      contentRating: 'pg13',
    })) as never);
    await expect(resync()).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(row(LIVE).contentRating).toBe('x');
  });
});
