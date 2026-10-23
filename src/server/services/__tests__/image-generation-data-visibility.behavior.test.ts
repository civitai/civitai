import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import type * as UserService from '~/server/services/user.service';

/**
 * Runs `getImageGenerationData`'s visibility query against an in-process Postgres, so each image
 * state is decided by the real predicate `image.get` uses rather than by a rendered string.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(),
}));
// The image row is read through @civitai/db-queries (Kysely over the app's own pg pool), not the
// Prisma client, so it is stubbed at that module. Its parity with the Prisma read it replaced is
// pinned against a real database in image-generation-data.kysely-parity.test.ts.
vi.mock('@civitai/db-queries/image', () => ({ getImageGenerationFields: vi.fn() }));

import { getImageGenerationData } from '../image.service';
import { imageResourcesCache } from '~/server/redis/caches';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';
import type { MediaViewer } from '~/server/utils/image-media-visibility';
import { amIBlockedByUser } from '~/server/services/user.service';
import { getImageGenerationFields } from '@civitai/db-queries/image';
import { kyselyRead } from '~/server/db/kyselyDb';

const imageRow = vi.mocked(getImageGenerationFields);

const OWNER = 10;
const VIEWER = 20;
const MANAGER = 30;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TYPE "CollectionContributorPermission" AS ENUM ('VIEW', 'ADD', 'ADD_REVIEW', 'MANAGE');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, "nsfwLevel" int DEFAULT 1,
      "needsReview" text, ingestion "ImageIngestionStatus" DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean DEFAULT false, metadata jsonb NOT NULL DEFAULT '{}',
      "scanJobs" jsonb
    );
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "publishedAt" timestamp,
      availability "Availability" DEFAULT 'Public', "collectionId" int
    );
    CREATE TABLE "Article" (
      id int PRIMARY KEY, "coverId" int, status text, "publishedAt" timestamp, ingestion text
    );
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
    CREATE TABLE "Bounty" (
      id int PRIMARY KEY, "userId" int, availability "Availability" DEFAULT 'Public'
    );
    CREATE TABLE "BountyEntry" (id int PRIMARY KEY, "bountyId" int NOT NULL, "userId" int);
    CREATE TABLE "ImageConnection" ("imageId" int, "entityId" int, "entityType" text);
  `);
  const raw = pgliteRaw(db);
  // Tagged-template calls, and `managesPostCollection`'s single prebuilt `Prisma.sql` argument.
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) =>
      Array.isArray(first)
        ? raw.queryRaw(first as TemplateStringsArray, ...values)
        : (await db.query((first as Prisma.Sql).text, (first as Prisma.Sql).values)).rows
  );
});

beforeEach(async () => {
  await db.exec(
    `TRUNCATE "Image", "Post", "CollectionContributor", "Article", "Bounty", "BountyEntry", "ImageConnection";`
  );
  vi.mocked(amIBlockedByUser).mockReset().mockResolvedValue(false);
  vi.spyOn(imageResourcesCache, 'fetch').mockResolvedValue({});
  imageRow.mockReset().mockResolvedValue({
    hideMeta: false,
    generationProcess: null,
    meta: { prompt: 'a prompt' },
    type: 'image',
    tools: [],
    techniques: [],
  } as never);
});

/** One image (id 1) with the given columns, in post 1 unless `post` is null. */
async function seed({
  image = {},
  post = {},
}: {
  image?: Record<string, string>;
  post?: Record<string, string> | null;
}) {
  const imageCols = {
    id: '1',
    '"userId"': String(OWNER),
    '"postId"': post ? '1' : 'NULL',
    ...image,
  };
  await db.exec(
    `INSERT INTO "Image" (${Object.keys(imageCols).join(', ')}) VALUES (${Object.values(
      imageCols
    ).join(', ')})`
  );
  if (post) {
    const postCols = {
      id: '1',
      '"userId"': String(OWNER),
      '"publishedAt"': `now() - interval '1 day'`,
      ...post,
    };
    await db.exec(
      `INSERT INTO "Post" (${Object.keys(postCols).join(', ')}) VALUES (${Object.values(
        postCols
      ).join(', ')})`
    );
  }
}

type Viewer = { userId?: number; isModerator?: boolean };
const ANON: Viewer = {};
const OTHER: Viewer = { userId: VIEWER };
const SELF: Viewer = { userId: OWNER };
const MOD: Viewer = { userId: VIEWER, isModerator: true };

/** A request context: on the mature domain unless `canViewNsfw` is false, optionally a crawler. */
function ctxFor(viewer: Viewer, { canViewNsfw = true, crawler = false } = {}) {
  return {
    user: viewer.userId ? { id: viewer.userId, isModerator: viewer.isModerator } : undefined,
    features: { canViewNsfw },
    req: { headers: crawler ? { 'x-civitai-verified-bot': 'googlebot' } : {} },
    cache: { edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 },
  } as unknown as MediaViewer & { cache: { edgeTTL: number } };
}

async function sees(viewer: Viewer) {
  try {
    const data = await getImageGenerationData({ id: 1, viewer: ctxFor(viewer) });
    // The payload itself, so a stubbed early return can't pass as "visible".
    expect(data.meta?.prompt).toBe('a prompt');
    return true;
  } catch (e) {
    if ((e as { code?: string }).code === 'NOT_FOUND') return false;
    throw e;
  }
}

const HIDDEN: Array<[string, Parameters<typeof seed>[0]]> = [
  ['awaiting review', { image: { '"needsReview"': `'minor'` } }],
  ['not yet scanned', { image: { ingestion: `'Pending'` } }],
  [
    'with a mod-locked rating from a Knights vote whose scan errored',
    {
      image: {
        ingestion: `'Error'`,
        '"nsfwLevelLocked"': 'true',
        metadata: `'{"nsfwLevelReason":"Knights Vote"}'`,
      },
    },
  ],
  [
    'removed at ingestion, even with a locked rating',
    { image: { ingestion: `'Blocked'`, '"nsfwLevelLocked"': 'true' } },
  ],
  ['awaiting review, with no post', { image: { '"needsReview"': `'minor'` }, post: null }],
  [
    'rated Blocked, with no post',
    { image: { '"nsfwLevelLocked"': 'false', '"nsfwLevel"': '32' }, post: null },
  ],
  ['rated Blocked', { image: { '"nsfwLevel"': '32' } }],
  ['in an unpublished post', { post: { '"publishedAt"': 'NULL' } }],
  ['in a post scheduled for later', { post: { '"publishedAt"': `now() + interval '1 day'` } }],
  ['in a Private post', { post: { availability: `'Private'` } }],
];

describe('getImageGenerationData visibility', () => {
  it('serves an image in a published public post to everyone', async () => {
    await seed({});
    expect(await sees(ANON)).toBe(true);
    expect(await sees(OTHER)).toBe(true);
  });

  it('serves a postless image only to its owner unless something shows it publicly', async () => {
    await seed({ post: null });
    expect(await sees(ANON)).toBe(false);
    expect(await sees(OTHER)).toBe(false);
    expect(await sees(SELF)).toBe(true);
  });

  it.each([
    [
      'the cover of a published article',
      `INSERT INTO "Article" VALUES (1, 1, 'Published', now(), 'Scanned')`,
    ],
    [
      'an image of a Public bounty',
      `INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Public');
        INSERT INTO "ImageConnection" VALUES (1, 4, 'Bounty')`,
    ],
    [
      'an image of an entry on a Public bounty',
      `INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Public');
        INSERT INTO "BountyEntry" VALUES (8, 4, ${OWNER});
        INSERT INTO "ImageConnection" VALUES (1, 8, 'BountyEntry')`,
    ],
  ])('serves a postless image that is %s to everyone', async (_label, shown) => {
    await seed({ post: null });
    await db.exec(shown);
    expect(await sees(ANON)).toBe(true);
    expect(await sees(OTHER)).toBe(true);
  });

  it('serves an image whose stalled scan a moderator replaced with a locked rating', async () => {
    await seed({ image: { ingestion: `'Pending'`, '"nsfwLevelLocked"': 'true' } });
    expect(await sees(ANON)).toBe(true);
  });

  it('serves an errored scan with a moderator-locked rating', async () => {
    await seed({ image: { ingestion: `'Error'`, '"nsfwLevelLocked"': 'true' } });
    expect(await sees(OTHER)).toBe(true);
  });

  it('applies the post owner, not the image owner, to an unpublished post', async () => {
    // Another user's image in OWNER's unpublished post.
    await seed({ image: { '"userId"': String(VIEWER) }, post: { '"publishedAt"': 'NULL' } });
    expect(await sees({ userId: OWNER })).toBe(true);
    expect(await sees({ userId: VIEWER })).toBe(false);
  });

  it('applies the post owner, not the image owner, to a Private post', async () => {
    await seed({ image: { '"userId"': String(VIEWER) }, post: { availability: `'Private'` } });
    expect(await sees({ userId: OWNER })).toBe(true);
    expect(await sees({ userId: VIEWER })).toBe(false);
  });

  it('answers NOT_FOUND for an id that does not exist', async () => {
    expect(await sees(MOD)).toBe(false);
  });

  it('answers NOT_FOUND when the image row is gone after the visibility check passed', async () => {
    await seed({});
    imageRow.mockResolvedValue(null);
    expect(await sees(ANON)).toBe(false);
  });

  // A stored meta number outside double range reaches this function as Infinity (node-postgres's
  // JSON.parse). Prisma's engine threw on it instead, so the request failed. These pin what the
  // endpoint does with it now.
  it('drops the whole meta when a schema-typed field like seed is out of range', async () => {
    await seed({});
    imageRow.mockResolvedValue({
      hideMeta: false,
      generationProcess: 'txt2img',
      meta: { prompt: 'a prompt', seed: Infinity },
      type: 'image',
      tools: [],
      techniques: [],
    } as never);
    const data = await getImageGenerationData({ id: 1, viewer: ctxFor(ANON) });
    expect(data.meta).toBeUndefined();
    expect(data.process).toBeUndefined();
    expect(data.canRemix).toBe(false);
  });

  it('passes an out-of-range value in an untyped meta key through as Infinity', async () => {
    await seed({});
    imageRow.mockResolvedValue({
      hideMeta: false,
      generationProcess: null,
      meta: { prompt: 'a prompt', customScale: Infinity },
      type: 'image',
      tools: [],
      techniques: [],
    } as never);
    const data = await getImageGenerationData({ id: 1, viewer: ctxFor(ANON) });
    expect(data.meta?.prompt).toBe('a prompt');
    expect((data.meta as Record<string, unknown>).customScale).toBe(Infinity);
  });

  it('reads the image row from the read replica client, for the requested id', async () => {
    // `toBe`, not a structural match: kyselyRead and kyselyWrite are distinct clients that compare
    // deep-equal, so only identity catches the read routed at the writer.
    await seed({});
    expect(await sees(ANON)).toBe(true);
    expect(imageRow).toHaveBeenCalledTimes(1);
    expect(imageRow.mock.calls[0][0]).toBe(kyselyRead);
    expect(imageRow.mock.calls[0][1]).toBe(1);
  });

  describe.each(HIDDEN)('an image %s', (_label, state) => {
    beforeEach(() => seed(state));

    it('is not found for a signed-out viewer', async () => {
      expect(await sees(ANON)).toBe(false);
    });

    it('is not found for another signed-in user', async () => {
      expect(await sees(OTHER)).toBe(false);
    });

    it('is served to its owner', async () => {
      expect(await sees(SELF)).toBe(true);
    });

    it('is served to a moderator', async () => {
      expect(await sees(MOD)).toBe(true);
    });
  });

  it('serves an unreviewed image to a manager of the collection its post was submitted to', async () => {
    await seed({ image: { '"needsReview"': `'minor'` }, post: { '"collectionId"': '7' } });
    await db.exec(
      `INSERT INTO "CollectionContributor" VALUES (7, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[]),
        (7, ${VIEWER}, ARRAY['ADD']::"CollectionContributorPermission"[])`
    );
    expect(await sees({ userId: MANAGER })).toBe(true);
    expect(await sees(OTHER)).toBe(false);
  });

  it("does not serve it to a manager when the post's author does not own the image", async () => {
    // Another user's unreviewed image in OWNER's post: OWNER chose the collection, not its owner.
    await seed({
      image: { '"needsReview"': `'minor'`, '"userId"': String(VIEWER) },
      post: { '"collectionId"': '7' },
    });
    await db.exec(
      `INSERT INTO "CollectionContributor" VALUES (7, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[])`
    );
    expect(await sees({ userId: MANAGER })).toBe(false);
  });

  it('is not found for a viewer the owner has blocked', async () => {
    await seed({});
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(OTHER)).toBe(false);
    // A read: the block check stays cache-only.
    expect(amIBlockedByUser).toHaveBeenCalledWith({
      userId: VIEWER,
      targetUserId: OWNER,
      confirmOnPrimary: false,
    });
  });

  it('skips the block check for moderators and signed-out viewers', async () => {
    await seed({});
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(MOD)).toBe(true);
    expect(await sees(ANON)).toBe(true);
    expect(amIBlockedByUser).not.toHaveBeenCalled();
  });
});

describe('getImageGenerationData media links', () => {
  const SOURCE = 'https://orchestration-new.civitai.com/source.png';
  const HOMEPAGE = 'https://example.com/tool';
  const PROMPT = 'a prompt, see https://civitai.com/posts/1 for more';
  // Every shape a source image is recorded in, each with a marker the assertions look for.
  const MEDIA_META = {
    prompt: PROMPT,
    images: [{ url: SOURCE, width: 512, height: 512 }],
    controlNets: [`${SOURCE}?controlnet`],
    video: { url: `${SOURCE}?video` },
    styleReferences: [{ image: { URL: 'image-key-without-a-scheme' }, strength: 1 }],
    mask: '  data:image/png;base64,AAAA  ',
    thumbnail: '//image.civitai.com/protocol-relative.png',
    comfy: JSON.stringify({ prompt: { '1': { inputs: { image: `${SOURCE}?comfy` } } } }),
    workflow: 'txt2img:face-fix',
    external: { source: { name: 'Tool', homepage: HOMEPAGE } },
  };
  const MARKERS = [SOURCE, HOMEPAGE, 'image-key-without', 'data:image', 'protocol-relative'];

  function mockImageRow(overrides: Record<string, unknown> = {}) {
    imageRow.mockResolvedValue({
      hideMeta: false,
      generationProcess: null,
      meta: MEDIA_META,
      type: 'image',
      tools: [],
      techniques: [],
      ...overrides,
    } as never);
  }

  beforeEach(async () => {
    mockImageRow();
    // An R-rated image in a published post that was submitted to collection 7.
    await seed({ image: { '"nsfwLevel"': '4' }, post: { '"collectionId"': '7' } });
    await db.exec(
      `INSERT INTO "CollectionContributor" VALUES (7, ${MANAGER}, ARRAY['MANAGE']::"CollectionContributorPermission"[])`
    );
  });

  async function fetchFor(viewer: Viewer, options?: Parameters<typeof ctxFor>[1]) {
    const ctx = ctxFor(viewer, options);
    const data = await getImageGenerationData({ id: 1, viewer: ctx });
    return { data, json: JSON.stringify(data), ctx };
  }

  const leaked = (json: string) => MARKERS.filter((marker) => json.includes(marker));

  it.each([
    ['signed out, SFW domain', ANON, { canViewNsfw: false }],
    ['signed out, mature domain', ANON, {}],
    ['signed in, SFW domain', OTHER, { canViewNsfw: false }],
    ['a crawler on the SFW domain', ANON, { canViewNsfw: false, crawler: true }],
  ] as const)('withholds them from a viewer %s', async (_label, viewer, options) => {
    const { data, json } = await fetchFor(viewer, options);
    expect(leaked(json)).toEqual([]);
    // The rest stays: links inside the prompt text, and what is left of an entry beside its image.
    const meta = data.meta as Record<string, unknown>;
    expect(meta.prompt).toBe(PROMPT);
    expect(meta.styleReferences).toEqual([{ strength: 1 }]);
    // Entries that lose their link go whole, not as an input with no source.
    expect(meta.images ?? []).toEqual([]);
    expect(meta).not.toHaveProperty('video');
    expect(meta).not.toHaveProperty('comfy');
    // The generator workflow name and the process label are not media.
    expect(meta.workflow).toBe('txt2img:face-fix');
    expect(data.process).toBe('comfy');
  });

  it.each([
    ['signed in on the mature domain', OTHER, {}],
    ['the owner, SFW domain', SELF, { canViewNsfw: false }],
    ['a moderator, SFW domain', MOD, { canViewNsfw: false }],
    ["a manager of the post's collection, SFW domain", { userId: MANAGER }, { canViewNsfw: false }],
  ] as const)('keeps them for %s', async (_label, viewer, options) => {
    const { json } = await fetchFor(viewer, options);
    expect(leaked(json)).toEqual(MARKERS);
  });

  it.each([
    [2, true],
    [0, false],
    [2 | 4, false],
  ])(
    'a signed-in viewer on the SFW domain, image rated %i: links kept is %s',
    async (level, kept) => {
      await db.exec(`UPDATE "Image" SET "nsfwLevel" = ${level}`);
      const { json } = await fetchFor(OTHER, { canViewNsfw: false });
      expect(leaked(json)).toEqual(kept ? MARKERS : []);
    }
  );

  it('keeps them for a signed-out viewer of a PG image', async () => {
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = 1`);
    const { json } = await fetchFor(ANON, { canViewNsfw: false });
    expect(leaked(json)).toEqual(MARKERS);
  });

  it('withholds them on a video the same way', async () => {
    mockImageRow({ type: 'video' });
    const { json } = await fetchFor(ANON, { canViewNsfw: false });
    expect(leaked(json)).toEqual([]);
  });

  it('withholds external links when the rest of the meta is hidden', async () => {
    mockImageRow({ hideMeta: true });
    const { data, json } = await fetchFor(ANON, { canViewNsfw: false });
    expect(data.meta).toBeUndefined();
    expect(leaked(json)).toEqual([]);
    expect(data.external).toEqual({ source: { name: 'Tool' } });
  });

  it('keeps them for a crawler on the mature domain, out of every shared cache', async () => {
    const { json, ctx } = await fetchFor(ANON, { crawler: true });
    expect(json).toContain(SOURCE);
    expect(ctx.cache).toEqual({ edgeTTL: 0, browserTTL: 0, staleWhileRevalidate: 0 });
  });

  it('leaves the cache alone for an ordinary signed-out answer', async () => {
    const { ctx } = await fetchFor(ANON, {});
    expect(ctx.cache).toEqual({ edgeTTL: 60, browserTTL: 60, staleWhileRevalidate: 30 });
  });
});

describe('getImageGenerationData source media', () => {
  const SOURCE = 'https://orchestration-new.civitai.com/source.png';
  const SOURCE_OWNER = 40;

  function mockMeta(sourceImageIds: number[]) {
    imageRow.mockResolvedValue({
      hideMeta: false,
      generationProcess: null,
      meta: {
        prompt: 'an edit',
        workflow: 'img2img:edit',
        images: [{ url: SOURCE, width: 512, height: 512 }],
        extra: { sourceImageIds },
      },
      type: 'image',
      tools: [],
      techniques: [],
    } as never);
  }

  /** A PG output (id 1) made from a source (id 2, in its owner's published post 2) rated `level`. */
  async function seedEdit(level: number) {
    await seed({});
    await db.exec(
      `INSERT INTO "Image" (id, "userId", "nsfwLevel", "postId") VALUES (2, ${SOURCE_OWNER}, ${level}, 2);
        INSERT INTO "Post" (id, "userId", "publishedAt") VALUES (2, ${SOURCE_OWNER}, now() - interval '1 day')`
    );
    mockMeta([2]);
  }

  async function linksFor(viewer: Viewer, options?: Parameters<typeof ctxFor>[1]) {
    const data = await getImageGenerationData({ id: 1, viewer: ctxFor(viewer, options) });
    expect(data.meta?.prompt).toBe('an edit');
    return JSON.stringify(data).includes(SOURCE);
  }

  it.each([
    ['signed out, SFW domain', ANON, { canViewNsfw: false }],
    ['signed out, mature domain', ANON, {}],
    ['signed in, SFW domain', OTHER, { canViewNsfw: false }],
  ] as const)('withholds an R source from a viewer %s', async (_label, viewer, options) => {
    await seedEdit(4);
    expect(await linksFor(viewer, options)).toBe(false);
  });

  it.each([
    ['signed in on the mature domain', OTHER, {}],
    ["the output's owner", SELF, { canViewNsfw: false }],
    ["the source's owner", { userId: SOURCE_OWNER }, { canViewNsfw: false }],
    ['a moderator', MOD, { canViewNsfw: false }],
  ] as const)('keeps an R source for %s', async (_label, viewer, options) => {
    await seedEdit(4);
    expect(await linksFor(viewer, options)).toBe(true);
  });

  it('keeps a PG source for a signed-out viewer', async () => {
    await seedEdit(1);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(true);
  });

  it('withholds a source rated Blocked even where nothing is capped', async () => {
    await seedEdit(32);
    expect(await linksFor(OTHER, {})).toBe(false);
    expect(await linksFor({ userId: SOURCE_OWNER }, {})).toBe(true);
  });

  it('withholds a postless source from everyone but its owner, as image.get does', async () => {
    await seedEdit(1);
    await db.exec(`UPDATE "Image" SET "postId" = NULL WHERE id = 2`);
    expect(await linksFor(OTHER, {})).toBe(false);
    expect(await linksFor({ userId: SOURCE_OWNER }, {})).toBe(true);
  });

  it('withholds a source that no longer exists', async () => {
    await seed({});
    mockMeta([99]);
    expect(await linksFor(OTHER, {})).toBe(false);
  });

  it('withholds a source the viewer could not open', async () => {
    await seedEdit(1);
    await db.exec(`UPDATE "Image" SET "needsReview" = 'minor' WHERE id = 2`);
    expect(await linksFor(OTHER, {})).toBe(false);
    expect(await linksFor({ userId: SOURCE_OWNER }, {})).toBe(true);
    await db.exec(`
      UPDATE "Image" SET "needsReview" = NULL WHERE id = 2;
      UPDATE "Post" SET "publishedAt" = NULL WHERE id = 2;
    `);
    expect(await linksFor(OTHER, {})).toBe(false);
  });

  it('withholds a source whose owner has blocked the viewer', async () => {
    await seedEdit(1);
    vi.mocked(amIBlockedByUser).mockImplementation(
      async ({ targetUserId }) => targetUserId === SOURCE_OWNER
    );
    expect(await linksFor(OTHER, {})).toBe(false);
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: SOURCE_OWNER });
  });

  it('withholds when any one source is above the cap', async () => {
    await seedEdit(1);
    await db.exec(
      `INSERT INTO "Image" (id, "userId", "nsfwLevel", "postId") VALUES (3, ${SOURCE_OWNER}, 4, 2)`
    );
    mockMeta([2, 3]);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(false);
  });

  it('counts a source listed twice once', async () => {
    await seedEdit(1);
    mockMeta([2, 2]);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(true);
  });

  it('withholds an unrated source under a cap', async () => {
    await seedEdit(0);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(false);
  });

  it('keeps a Blocked or missing source for a moderator', async () => {
    await seedEdit(32);
    mockMeta([2, 99]);
    expect(await linksFor(MOD, { canViewNsfw: false })).toBe(true);
  });

  it('reads the sources even when another extra field does not parse', async () => {
    await seedEdit(4);
    imageRow.mockResolvedValue({
      hideMeta: false,
      generationProcess: null,
      meta: {
        prompt: 'an edit',
        images: [{ url: SOURCE, width: 512, height: 512 }],
        extra: { sourceImageIds: [2], remixOfId: 'not-a-number' },
      },
      type: 'image',
      tools: [],
      techniques: [],
    } as never);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(false);
  });

  it('ignores the image listed as its own source', async () => {
    await seed({});
    mockMeta([1]);
    expect(await linksFor(ANON, { canViewNsfw: false })).toBe(true);
  });
});

/** `getImage`'s visibility conditions over the same rows, so the extraction is pinned by behaviour too. */
describe('imageVisibilityConditions for image.get', () => {
  async function visibleTo(viewer: Viewer) {
    const raw = pgliteRaw(db);
    const where = Prisma.join(
      [Prisma.sql`i.id = 1`, ...imageVisibilityConditions(viewer)],
      ' AND '
    );
    const rows =
      await raw.queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId" WHERE ${where}`;
    return rows.length === 1;
  }

  it('hides a postless image from everyone but its owner', async () => {
    await seed({ post: null });
    expect(await visibleTo(ANON)).toBe(false);
    expect(await visibleTo(OTHER)).toBe(false);
    expect(await visibleTo(SELF)).toBe(true);
    expect(await visibleTo(MOD)).toBe(true);
  });

  it('admits a postless cover of a readable article', async () => {
    await seed({ post: null });
    await db.exec(`INSERT INTO "Article" VALUES (1, 1, 'Published', now(), 'Scanned')`);
    expect(await visibleTo(ANON)).toBe(true);
    await db.exec(`UPDATE "Article" SET status = 'Draft'`);
    expect(await visibleTo(ANON)).toBe(false);
  });

  it('does not let an image in an unpublished post borrow an article cover', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });
    await db.exec(`INSERT INTO "Article" VALUES (1, 1, 'Published', now(), 'Scanned')`);
    expect(await visibleTo(OTHER)).toBe(false);
  });

  it.each([
    ['an unpublished post', { '"publishedAt"': 'NULL' }],
    ['a Private post', { availability: `'Private'` }],
  ])('applies the post checks to an image in %s', async (_label, post) => {
    await seed({ post });
    expect(await visibleTo(ANON)).toBe(false);
    expect(await visibleTo(OTHER)).toBe(false);
    expect(await visibleTo(SELF)).toBe(true);
  });

  // A bounty's images follow the bounty page (canViewBounty): shown unless the bounty is Private,
  // whose owner still sees them. An entry's images follow the entry's bounty.
  describe.each([
    ['a bounty', `INSERT INTO "ImageConnection" VALUES (1, 4, 'Bounty')`],
    [
      'an entry on a bounty',
      `INSERT INTO "BountyEntry" VALUES (8, 4, ${OWNER});
        INSERT INTO "ImageConnection" VALUES (1, 8, 'BountyEntry')`,
    ],
  ])('a postless image of %s', (_label, connect) => {
    const BOUNTY_OWNER = { userId: MANAGER };

    beforeEach(async () => {
      await seed({ post: null });
      await db.exec(`INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Public'); ${connect}`);
    });

    it.each(['Public', 'Unsearchable'])('is shown to everyone on a %s bounty', async (level) => {
      await db.exec(`UPDATE "Bounty" SET availability = '${level}'`);
      expect(await visibleTo(ANON)).toBe(true);
      expect(await visibleTo(OTHER)).toBe(true);
    });

    it('on a Private bounty, is shown only to the bounty owner and the image owner', async () => {
      await db.exec(`UPDATE "Bounty" SET availability = 'Private'`);
      expect(await visibleTo(ANON)).toBe(false);
      expect(await visibleTo(OTHER)).toBe(false);
      expect(await visibleTo(BOUNTY_OWNER)).toBe(true);
      expect(await visibleTo(SELF)).toBe(true);
    });

    it('keeps the review and Blocked checks', async () => {
      await db.exec(`UPDATE "Image" SET "needsReview" = 'minor'`);
      expect(await visibleTo(ANON)).toBe(false);
      await db.exec(`UPDATE "Image" SET "needsReview" = NULL, "nsfwLevel" = 32`);
      expect(await visibleTo(ANON)).toBe(false);
      expect(await visibleTo(SELF)).toBe(true);
    });
  });

  it.each([
    ['a Private bounty whose id is also an entry on a Public one', `(1, 4, 'Bounty')`],
    ['another kind of entity sharing an id with a Public bounty', `(1, 9, 'Article')`],
  ])('does not admit an image connected to %s', async (_label, connection) => {
    // Bounty 4 is Private and entry 4 sits on Public bounty 9. Only a join that ignores the
    // connection's entity type reaches a Public bounty from either connection.
    await seed({ post: null });
    await db.exec(`INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Private'), (9, ${MANAGER}, 'Public');
      INSERT INTO "BountyEntry" VALUES (4, 9, ${OWNER});
      INSERT INTO "ImageConnection" VALUES ${connection}`);
    expect(await visibleTo(ANON)).toBe(false);
  });

  it.each([
    ['a Private bounty, beside a Public one', 4, false],
    ['a Public bounty, beside a Private one', 9, true],
  ])("follows the entry's own bounty when it is %s", async (_label, bountyId, shown) => {
    await seed({ post: null });
    await db.exec(`INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Private'), (9, ${MANAGER}, 'Public');
      INSERT INTO "BountyEntry" VALUES (8, ${bountyId}, ${OWNER});
      INSERT INTO "ImageConnection" VALUES (1, 8, 'BountyEntry')`);
    expect(await visibleTo(ANON)).toBe(shown);
  });

  it('on a Private bounty, does not show an entry image to an entry owner who did not upload it', async () => {
    // The entry page itself is closed to everyone but the bounty owner (assertBountyVisible).
    const ENTRY_OWNER = 40;
    await seed({ post: null });
    await db.exec(`INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Private');
      INSERT INTO "BountyEntry" VALUES (8, 4, ${ENTRY_OWNER});
      INSERT INTO "ImageConnection" VALUES (1, 8, 'BountyEntry')`);
    expect(await visibleTo({ userId: ENTRY_OWNER })).toBe(false);
    expect(await visibleTo({ userId: MANAGER })).toBe(true);
  });

  it("does not admit a postless image through another image's bounty", async () => {
    await seed({ post: null });
    await db.exec(`INSERT INTO "Image" (id, "userId") VALUES (2, ${OWNER});
      INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Public');
      INSERT INTO "BountyEntry" VALUES (8, 4, ${OWNER});
      INSERT INTO "ImageConnection" VALUES (2, 4, 'Bounty'), (2, 8, 'BountyEntry')`);
    expect(await visibleTo(ANON)).toBe(false);
  });

  it('does not let an image in an unpublished post borrow a bounty', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });
    await db.exec(`INSERT INTO "Bounty" VALUES (4, ${MANAGER}, 'Public');
      INSERT INTO "ImageConnection" VALUES (1, 4, 'Bounty')`);
    expect(await visibleTo(OTHER)).toBe(false);
  });

  it('keeps the review and Blocked checks on a postless image', async () => {
    await seed({ image: { '"needsReview"': `'minor'` }, post: null });
    expect(await visibleTo(ANON)).toBe(false);
    await db.exec(`UPDATE "Image" SET "needsReview" = NULL, "nsfwLevel" = 32`);
    expect(await visibleTo(ANON)).toBe(false);
    expect(await visibleTo(SELF)).toBe(true);
  });
});
