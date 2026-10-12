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

import { getImageGenerationData } from '../image.service';
import { imageResourcesCache } from '~/server/redis/caches';
import { imageVisibilityConditions } from '~/server/services/image-visibility.service';
import type { MediaViewer } from '~/server/utils/image-media-visibility';
import { amIBlockedByUser } from '~/server/services/user.service';

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
    CREATE TABLE "CollectionContributor" (
      "collectionId" int, "userId" int, permissions "CollectionContributorPermission"[]
    );
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
  await db.exec(`TRUNCATE "Image", "Post", "CollectionContributor";`);
  vi.mocked(amIBlockedByUser).mockReset().mockResolvedValue(false);
  vi.spyOn(imageResourcesCache, 'fetch').mockResolvedValue({});
  dbMock.dbRead.image.findUnique.mockResolvedValue({
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

  it('serves a postless image to everyone, as image.get does for images outside a post', async () => {
    await seed({ post: null });
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

  it('is not found for a viewer the owner has blocked', async () => {
    await seed({});
    vi.mocked(amIBlockedByUser).mockResolvedValue(true);
    expect(await sees(OTHER)).toBe(false);
    expect(amIBlockedByUser).toHaveBeenCalledWith({ userId: VIEWER, targetUserId: OWNER });
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

  beforeEach(async () => {
    dbMock.dbRead.image.findUnique.mockResolvedValue({
      hideMeta: false,
      generationProcess: null,
      meta: {
        prompt: PROMPT,
        images: [{ url: SOURCE, width: 512, height: 512 }],
        video: { url: SOURCE },
        styleReferences: [{ image: { url: 'image-key-without-a-scheme' } }],
        external: { source: { name: 'Tool', homepage: HOMEPAGE } },
      },
      type: 'image',
      tools: [],
      techniques: [],
    } as never);
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

  const withheld = (json: string) =>
    !json.includes(SOURCE) && !json.includes(HOMEPAGE) && !json.includes('image-key-without');

  it.each([
    ['signed out, SFW domain', ANON, { canViewNsfw: false }],
    ['signed out, mature domain', ANON, {}],
    ['signed in, SFW domain', OTHER, { canViewNsfw: false }],
    ['a crawler on the SFW domain', ANON, { canViewNsfw: false, crawler: true }],
  ] as const)('withholds them from a viewer %s', async (_label, viewer, options) => {
    const { data, json } = await fetchFor(viewer, options);
    expect(withheld(json)).toBe(true);
    // The rest of the generation data stays, including links inside the prompt text.
    expect(data.meta?.prompt).toBe(PROMPT);
    expect((data.meta as { styleReferences?: unknown[] })?.styleReferences).toEqual([
      { image: {} },
    ]);
  });

  it.each([
    ['signed in on the mature domain', OTHER, {}],
    ['the owner, SFW domain', SELF, { canViewNsfw: false }],
    ['a moderator, SFW domain', MOD, { canViewNsfw: false }],
    ["a manager of the post's collection, SFW domain", { userId: MANAGER }, { canViewNsfw: false }],
  ] as const)('keeps them for %s', async (_label, viewer, options) => {
    const { json } = await fetchFor(viewer, options);
    expect(json).toContain(SOURCE);
    expect(json).toContain(HOMEPAGE);
    expect(json).toContain('image-key-without');
  });

  it('keeps them for a signed-out viewer of a PG image', async () => {
    await db.exec(`UPDATE "Image" SET "nsfwLevel" = 1`);
    const { json } = await fetchFor(ANON, { canViewNsfw: false });
    expect(json).toContain(SOURCE);
  });

  it('keeps them for a crawler on the mature domain, out of the shared cache', async () => {
    const { json, ctx } = await fetchFor(ANON, { crawler: true });
    expect(json).toContain(SOURCE);
    expect(ctx.cache.edgeTTL).toBe(0);
  });

  it('leaves the cache alone for an ordinary signed-out answer', async () => {
    const { ctx } = await fetchFor(ANON, {});
    expect(ctx.cache.edgeTTL).toBe(60);
  });
});

/** `getImage`'s two modes over the same rows, so the extraction is pinned by behaviour too. */
describe('imageVisibilityConditions for image.get', () => {
  async function visibleTo(viewer: Viewer, postGates: 'always' | 'none') {
    const raw = pgliteRaw(db);
    const where = Prisma.join(
      [Prisma.sql`i.id = 1`, ...imageVisibilityConditions({ ...viewer, postGates })],
      ' AND '
    );
    const rows =
      postGates === 'none'
        ? await raw.queryRaw`SELECT i.id FROM "Image" i WHERE ${where}`
        : await raw.queryRaw`SELECT i.id FROM "Image" i LEFT JOIN "Post" p ON p.id = i."postId" WHERE ${where}`;
    return rows.length === 1;
  }

  it('hides a postless image from everyone but its owner by default', async () => {
    await seed({ post: null });
    expect(await visibleTo(ANON, 'always')).toBe(false);
    expect(await visibleTo(OTHER, 'always')).toBe(false);
    expect(await visibleTo(SELF, 'always')).toBe(true);
    expect(await visibleTo(MOD, 'always')).toBe(true);
  });

  it('applies the post checks by default and skips them without the post', async () => {
    await seed({ post: { '"publishedAt"': 'NULL' } });
    expect(await visibleTo(ANON, 'always')).toBe(false);
    expect(await visibleTo(ANON, 'none')).toBe(true);
  });

  it('keeps the review and Blocked checks without the post', async () => {
    await seed({ image: { '"needsReview"': `'minor'` }, post: null });
    expect(await visibleTo(ANON, 'none')).toBe(false);
    await db.exec(`UPDATE "Image" SET "needsReview" = NULL, "nsfwLevel" = 32`);
    expect(await visibleTo(ANON, 'none')).toBe(false);
    expect(await visibleTo(SELF, 'none')).toBe(true);
  });
});
