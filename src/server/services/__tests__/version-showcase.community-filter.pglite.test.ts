import type { ImagesForModelVersions } from '~/server/services/image.service';
import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import type * as FliptClient from '~/server/flipt/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import { setEnv } from '~/__tests__/mocks/env.mock';
import { REDIS_KEYS } from '~/server/redis/client';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

/**
 * The version showcase's community images, run through the cache's real lookup SQL against PGlite.
 * Each refused image sits beside a clean control, so a filter that drops everything fails too.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// Flipt answers only the showcase kill switch, and only while a test pauses it.
const flipt = vi.hoisted(() => ({ paused: false }));
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: vi.fn(async () => undefined),
  isFliptSync: vi.fn((key: string) =>
    key === 'model-version-showcase-serve' && flipt.paused ? false : null
  ),
}));

const imageTags = vi.hoisted(() => new Map<number, number[]>());
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tagIdsForImagesCache: {
    fetch: async (ids: number[]) =>
      Object.fromEntries(ids.map((id) => [id, { imageId: id, tags: imageTags.get(id) ?? [] }])),
  },
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preventReplicationLagBatch: vi.fn(async () => undefined),
}));

const {
  getVersionShowcases,
  bustVersionShowcasesForUser,
  getShowcaseCommunityCovers,
  dropInvalidCommunityCovers,
  repointVersionShowcases,
  withCuratedShowcases,
  removeMyImageFromVersionShowcase,
  bustVersionShowcasesForImages,
  getMyImageShowcaseFeatures,
} = await import('../version-showcase.service');
const { getImagesForModelVersion } = await import('../image.service');
const { publicModelResponseKey } = await import('../model-version.service');
const { resetFeatureFlagsStateVersionCacheForTests } = await import('../feature-flags.service');

const CREATOR = 1;
const MODEL = 10;
const VERSION = 100;
const PG = 1;
const R = 4;

let db: PGlite;
let nextId = 1000;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM
      ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan');
    CREATE TABLE "User" (
      id int PRIMARY KEY, username text, settings jsonb, "bannedAt" timestamp, "deletedAt" timestamp
    );
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, "coverImageId" int, "sfwCoverImageId" int,
      nsfw boolean NOT NULL DEFAULT false, name text NOT NULL DEFAULT 'M',
      description text, "sfwName" text, "sfwDescription" text, meta jsonb
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
    CREATE TABLE "ImageResourceNew" ("imageId" int NOT NULL, "modelVersionId" int NOT NULL);
    CREATE TABLE "Post" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelVersionId" int,
      "publishedAt" timestamp, availability text NOT NULL DEFAULT 'Public'
    );
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "userId" int NOT NULL, "postId" int, index int NOT NULL DEFAULT 0,
      name text, url text NOT NULL DEFAULT '',
      "nsfwLevel" int NOT NULL, width int, height int, hash text, type text NOT NULL DEFAULT 'image',
      metadata jsonb, meta jsonb, "hideMeta" boolean NOT NULL DEFAULT false,
      minor boolean NOT NULL DEFAULT false, poi boolean NOT NULL DEFAULT false,
      "blockedFor" text, "needsReview" text, "acceptableMinor" boolean NOT NULL DEFAULT false,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb,
      "modelRestricted" boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
    CREATE TABLE "CreatorGalleryHiddenUser" ("creatorId" int, "userId" int);
    CREATE TABLE "ModelVersionShowcaseItem" (
      "modelVersionId" int, site text, "imageId" int, source text, position smallint,
      excluded boolean NOT NULL DEFAULT false, "removed" boolean NOT NULL DEFAULT false,
      "addedById" int, "createdAt" timestamp DEFAULT now()
    );
    INSERT INTO "User" (id, username) VALUES (${CREATOR}, 'creator');
    INSERT INTO "Model" VALUES (${MODEL}, ${CREATOR});
    INSERT INTO "ModelVersion" VALUES (${VERSION}, ${MODEL});
    CREATE UNIQUE INDEX ON "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId");
  `);
  // Integers typed as Prisma sends them.
  const INT4_OID = 23;
  const queryRaw = (async (strings: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
    const sql = Array.isArray(strings)
      ? Prisma.sql(strings as TemplateStringsArray, ...values)
      : (strings as Prisma.Sql);
    // The model level recompute after a cover change reads columns this fixture leaves out; it has
    // its own tests (nsfwLevels).
    if (sql.text.includes('bit_or(mv."nsfwLevel")')) return [];
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).rows;
  }) as never;
  dbMock.dbWrite.$queryRaw.mockImplementation(queryRaw);
  dbMock.dbRead.$queryRaw.mockImplementation(queryRaw);
  // A batch runs its statements in order on the one PGlite connection.
  dbMock.dbWrite.$executeRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...values);
    const paramTypes = sql.values.map((v) => (Number.isInteger(v) ? INT4_OID : 0));
    return (await db.query(sql.text, sql.values, { paramTypes })).affectedRows ?? 0;
  }) as never);
  dbMock.dbWrite.$transaction.mockImplementation((async (batch: Promise<unknown>[]) => {
    const results = [];
    for (const step of batch) results.push(await step);
    return results;
  }) as never);
  // The showcase cache's version-to-model read, from either client.
  for (const client of [dbMock.dbWrite, dbMock.dbRead])
    client.modelVersion.findMany.mockResolvedValue([{ id: VERSION, modelId: MODEL }] as never);
  // The public model response cache is Datapacket's; on here so its bust can be seen.
  setEnv({ IS_DATAPACKET: true });
  // The cover write reads and conditionally updates the model row, here in PGlite.
  dbMock.dbWrite.model.findUnique.mockImplementation(
    (async ({ where }: { where: { id: number } }) =>
      (await db.query(`SELECT * FROM "Model" WHERE id = $1`, [where.id])).rows[0] ?? null) as never
  );
  dbMock.dbWrite.model.updateMany.mockImplementation((async ({
    where,
    data,
  }: {
    where: { id: number; coverImageId: number | null; sfwCoverImageId: number | null };
    data: { coverImageId: number | null; sfwCoverImageId: number | null };
  }) => {
    const { affectedRows } = await db.query(
      `UPDATE "Model" SET "coverImageId" = $1, "sfwCoverImageId" = $2
       WHERE id = $3 AND "coverImageId" IS NOT DISTINCT FROM $4
         AND "sfwCoverImageId" IS NOT DISTINCT FROM $5`,
      [data.coverImageId, data.sfwCoverImageId, where.id, where.coverImageId, where.sfwCoverImageId]
    );
    return { count: affectedRows ?? 0 };
  }) as never);
});

/** The model's civitai.red cover, as stored. */
const redCover = async () =>
  (
    await db.query<{ coverImageId: number | null }>(
      `SELECT "coverImageId" FROM "Model" WHERE id = $1`,
      [MODEL]
    )
  ).rows[0].coverImageId;

/** The model's gallery settings, as the gallery settings cache holds them. */
const setGallery = (settings: Record<string, unknown>) =>
  redisMock.redis.set(
    `${REDIS_KEYS.MODEL.GALLERY_SETTINGS}:${MODEL}` as never,
    JSON.stringify({ sfwHeld: false, ...settings }) as never
  );

/** The redis deletes of the model's cached public API response. */
const publicResponseBusts = () =>
  redisMock.redis.del.mock.calls.filter(([keys]) =>
    [keys].flat().includes(publicModelResponseKey(MODEL, allBrowsingLevelsFlag) as never)
  );
afterAll(() => db.close());

beforeEach(async () => {
  installFakeCacheRedis();
  redisMock.redis.del.mockClear();
  flipt.paused = false;
  resetFeatureFlagsStateVersionCacheForTests();
  await db.exec(`
    DELETE FROM "ModelVersionShowcaseItem"; DELETE FROM "Image"; DELETE FROM "Post";
    DELETE FROM "ImageResourceNew";
    DELETE FROM "UserEngagement"; DELETE FROM "CreatorGalleryHiddenUser";
    DELETE FROM "User" WHERE id <> ${CREATOR};
    UPDATE "Model" SET "coverImageId" = NULL, "sfwCoverImageId" = NULL, nsfw = false;
  `);
});

/** A community image featured on the version and site; returns its id. */
async function featured({
  site = 'red',
  nsfwLevel = PG,
  user = {},
  image = {},
}: {
  site?: 'com' | 'red';
  nsfwLevel?: number;
  user?: { settings?: object; bannedAt?: string };
  image?: { tosViolation?: boolean; needsReview?: string };
} = {}) {
  const id = nextId++;
  await db.query(
    `INSERT INTO "User" (id, username, settings, "bannedAt") VALUES ($1, $2, $3, $4)`,
    [id, `author${id}`, user.settings ? JSON.stringify(user.settings) : null, user.bannedAt ?? null]
  );
  await db.query(
    `INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES ($1, $1, $2, now())`,
    [id, VERSION]
  );
  await db.query(
    `INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", "tosViolation", "needsReview")
     VALUES ($1, $1, $1, $2, $3, $4)`,
    [id, nsfwLevel, image.tosViolation ?? false, image.needsReview ?? null]
  );
  await db.query(
    `INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, "addedById")
     VALUES ($1, $2, $3, 'Community', $4)`,
    [VERSION, site, id, CREATOR]
  );
  return id;
}

async function served(site: 'com' | 'red' = 'red') {
  const showcase = (await getVersionShowcases([VERSION]))[VERSION];
  return showcase.community.filter((image) => image.site === site).map((image) => image.id);
}

describe('version showcase community filter', () => {
  it('serves a clean community image, credited to its author', async () => {
    const id = await featured();
    const showcase = (await getVersionShowcases([VERSION]))[VERSION];
    expect(showcase.community).toMatchObject([{ id, authorUsername: `author${id}` }]);
  });

  it("drops a banned author's image", async () => {
    const clean = await featured();
    await featured({ user: { bannedAt: '2026-01-01' } });
    expect(await served()).toEqual([clean]);
  });

  it('drops the image of an author who opted out', async () => {
    const clean = await featured();
    await featured({ user: { settings: { hideFromVersionShowcases: true } } });
    expect(await served()).toEqual([clean]);
  });

  it('drops an image when the creator and the author block each other, either way', async () => {
    const clean = await featured();
    const blockedByAuthor = await featured();
    const blockedByCreator = await featured();
    await db.query(`INSERT INTO "UserEngagement" VALUES ($1, $2, 'Block'), ($3, $4, 'Block')`, [
      blockedByAuthor,
      CREATOR,
      CREATOR,
      blockedByCreator,
    ]);
    expect(await served()).toEqual([clean]);
  });

  it('drops an author the creator hid from their galleries', async () => {
    const clean = await featured();
    const hidden = await featured();
    await db.query(`INSERT INTO "CreatorGalleryHiddenUser" VALUES ($1, $2)`, [CREATOR, hidden]);
    expect(await served()).toEqual([clean]);
  });

  it('serves only PG and PG-13 on civitai.com, and anything on civitai.red', async () => {
    const pg = await featured({ site: 'com', nsfwLevel: PG });
    await featured({ site: 'com', nsfwLevel: R });
    const redR = await featured({ site: 'red', nsfwLevel: R });
    expect(await served('com')).toEqual([pg]);
    expect(await served('red')).toEqual([redR]);
  });

  it('drops a TOS violation and an image waiting on review, like the owner showcase', async () => {
    const clean = await featured();
    await featured({ image: { tosViolation: true } });
    await featured({ image: { needsReview: 'minor' } });
    expect(await served()).toEqual([clean]);
  });

  it("applies the model's own gallery rules: hidden images and users, and the held level", async () => {
    const clean = await featured();
    const hiddenImage = await featured();
    const hiddenUser = await featured();
    await featured({ nsfwLevel: R });
    await setGallery({
      hiddenImages: { [VERSION]: [hiddenImage] },
      hiddenUsers: [{ id: hiddenUser }],
      sfwHeld: true,
      level: PG,
    });
    expect(await served()).toEqual([clean]);
  });

  it('drops an image moved off the version, and keeps one still made with it', async () => {
    const moved = await featured();
    const madeWith = await featured();
    await db.query(`UPDATE "Post" SET "modelVersionId" = NULL WHERE id IN ($1, $2)`, [
      moved,
      madeWith,
    ]);
    await db.query(`INSERT INTO "ImageResourceNew" VALUES ($1, $2)`, [madeWith, VERSION]);
    expect(await served()).toEqual([madeWith]);
  });

  it("drops a row the image's author removed", async () => {
    const clean = await featured();
    const removed = await featured();
    await db.query(`UPDATE "ModelVersionShowcaseItem" SET "removed" = true WHERE "imageId" = $1`, [
      removed,
    ]);
    expect(await served()).toEqual([clean]);
  });
});

describe('when a featured image stops qualifying', () => {
  it("a ban clears the model's community cover", async () => {
    const banned = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [banned, MODEL]);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [banned]);

    await bustVersionShowcasesForUser(banned);

    expect(await redCover()).toBeNull();
  });

  it('judges a cover against the current state when its showcase cache is stale', async () => {
    const banned = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [banned, MODEL]);
    expect(await served()).toContain(banned);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [banned]);

    await dropInvalidCommunityCovers([MODEL]);

    expect(await redCover()).toBeNull();
  });

  it('keeps a cover whose image is only waiting on a review, for when it clears', async () => {
    const pending = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [pending, MODEL]);
    await db.query(`UPDATE "Image" SET "needsReview" = 'poi' WHERE id = $1`, [pending]);

    await dropInvalidCommunityCovers([MODEL]);

    expect(await served()).not.toContain(pending);
    expect(await redCover()).toBe(pending);
  });

  it("clears a cover whose author the creator hid from the model's gallery", async () => {
    const hidden = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [hidden, MODEL]);
    await setGallery({ hiddenUsers: [{ id: hidden }] });

    await dropInvalidCommunityCovers([MODEL]);

    expect(await redCover()).toBeNull();
  });

  it('clears a cover whose image was removed for a ToS violation', async () => {
    const removed = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [removed, MODEL]);
    await db.query(`UPDATE "Image" SET "tosViolation" = true WHERE id = $1`, [removed]);

    await dropInvalidCommunityCovers([MODEL]);

    expect(await redCover()).toBeNull();
  });

  it('leaves a community cover whose author is still in good standing', async () => {
    const fine = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [fine, MODEL]);

    await bustVersionShowcasesForUser(fine);

    expect(await redCover()).toBe(fine);
    // The showcase was refreshed all the same, and so is the public model response carrying it.
    expect(publicResponseBusts()).toHaveLength(1);
  });

  it('a deleted image stops counting as a cover at once', async () => {
    const id = await featured();
    const before = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [id]);
    const after = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);

    expect(before.size).toBe(1);
    expect(after.size).toBe(0);
  });

  it('the public API serves a community image with its tags, so a tag filter judges it fairly', async () => {
    const id = await featured();
    await db.query(`UPDATE "ModelVersionShowcaseItem" SET position = 0 WHERE "imageId" = $1`, [id]);
    imageTags.set(id, [7, 8]);
    const images = (
      await withCuratedShowcases({ [VERSION]: { images: [] as ImagesForModelVersions[] } }, 'red')
    )[VERSION].images;
    expect(images.map((image) => [image.id, image.tags])).toEqual([[id, [7, 8]]]);
    // The creator's image shape: the showcase's own fields don't reach the public response.
    expect(images[0]).not.toHaveProperty('site');
    expect(images[0]).not.toHaveProperty('authorUsername');
  });

  it('the public API stops serving a deleted image at once, though the cache still holds it', async () => {
    const id = await featured();
    await db.query(`UPDATE "ModelVersionShowcaseItem" SET position = 0 WHERE "imageId" = $1`, [id]);
    const api = async () =>
      (
        await withCuratedShowcases({ [VERSION]: { images: [] as ImagesForModelVersions[] } }, 'red')
      )[VERSION].images.map((image) => image.id);
    expect(await api()).toEqual([id]);
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [id]);
    expect(await served()).toContain(id);
    expect(await api()).toEqual([]);
  });

  it('reads a community cover with its tags, for the card filters', async () => {
    const id = await featured();
    imageTags.set(id, [5]);
    const covers = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);
    expect([...covers.values()][0].image.tags).toEqual([5]);
  });

  it('a moderated image stops counting as a cover at once, though the cache still holds it', async () => {
    const id = await featured();
    expect((await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }])).size).toBe(1);
    await db.query(`UPDATE "Image" SET "tosViolation" = true WHERE id = $1`, [id]);
    expect(await served()).toContain(id);
    expect((await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }])).size).toBe(0);
  });

  it('an image re-rated above PG-13 stops being a .com cover, and keeps its .red one', async () => {
    const id = await featured({ site: 'com' });
    await db.query(
      `INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, "addedById")
       VALUES ($1, 'red', $2, 'Community', $3)`,
      [VERSION, id, CREATOR]
    );
    const before = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);
    expect([...before.values()][0].sites).toEqual(new Set(['com', 'red']));
    await db.query(`UPDATE "Image" SET "nsfwLevel" = $1 WHERE id = $2`, [R, id]);
    const after = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);
    const entry = [...after.values()][0];
    expect(entry.sites).toEqual(new Set(['red']));
    expect(entry.image.nsfwLevel).toBe(R);
  });

  it("a deleted image's cover is cleared, found through its showcase row", async () => {
    const id = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [id, MODEL]);
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [id]);

    await bustVersionShowcasesForImages([id]);

    expect(publicResponseBusts().length).toBeGreaterThan(0);
    expect(await redCover()).toBeNull();
  });

  it("doesn't count a row featured on another model", async () => {
    const id = await featured();
    const covers = await getShowcaseCommunityCovers([{ modelId: MODEL + 1, imageId: id }]);
    expect(covers.size).toBe(0);
  });
});

describe('the showcases an image is featured in, for the remove action', () => {
  it("lists them for the image's author and for a moderator, not for anyone else", async () => {
    const id = await featured();
    const list = (userId: number, isModerator: boolean) =>
      getMyImageShowcaseFeatures({ imageId: id, userId, isModerator });

    expect((await list(id, false)).map((row) => row.modelVersionId)).toEqual([VERSION]);
    expect((await list(CREATOR, true)).map((row) => row.modelVersionId)).toEqual([VERSION]);
    expect(await list(CREATOR, false)).toEqual([]);
  });
});

describe("an author's removal", () => {
  it('holds on both sites, so a save racing it on the other site cannot feature the image', async () => {
    const id = await featured({ site: 'red' });
    dbMock.dbWrite.image.findUnique.mockResolvedValue({ userId: id } as never);
    dbMock.dbWrite.modelVersion.findUnique.mockResolvedValue({
      id: VERSION,
      status: 'Published',
      model: { id: MODEL, name: 'M', userId: CREATOR, nsfw: false, status: 'Published' },
    } as never);

    redisMock.redis.del.mockClear();
    await removeMyImageFromVersionShowcase({ modelVersionId: VERSION, imageId: id, userId: id });

    const { rows } = await db.query<{ site: string; removed: boolean; position: number | null }>(
      `SELECT site, removed, position FROM "ModelVersionShowcaseItem" WHERE "imageId" = $1 ORDER BY site`,
      [id]
    );
    expect(rows).toEqual([
      { site: 'com', removed: true, position: null },
      { site: 'red', removed: true, position: null },
    ]);
    // What the save's insert does for that row: it conflicts and is skipped.
    const inserted = await db.query(
      `INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, "addedById")
       VALUES ($1, 'com', $2, 'Community', $3) ON CONFLICT DO NOTHING`,
      [VERSION, id, CREATOR]
    );
    expect(inserted.affectedRows).toBe(0);
    expect(await served('com')).not.toContain(id);
    // The public model response carries the showcase, so it is dropped too.
    expect(publicResponseBusts()).toHaveLength(1);
  });
});

describe('a version merge', () => {
  it("moves the sources' rows to the target, keeping the target's own row on a clash", async () => {
    await db.exec(`
      INSERT INTO "ModelVersion" VALUES (201, ${MODEL}), (202, ${MODEL}) ON CONFLICT DO NOTHING;
      INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, position, "addedById") VALUES
        (${VERSION}, 'red', 1, 'Owner', 0, ${CREATOR}),
        (201, 'red', 1, 'Owner', 5, ${CREATOR}),
        (201, 'red', 2, 'Community', 1, ${CREATOR}),
        (202, 'red', 2, 'Community', 2, ${CREATOR}),
        (202, 'com', 3, 'Community', 0, ${CREATOR});
    `);

    await repointVersionShowcases(VERSION, [201, 202]);

    const { rows } = await db.query<{
      modelVersionId: number;
      site: string;
      imageId: number;
      position: number;
    }>(
      `SELECT "modelVersionId", site, "imageId", position FROM "ModelVersionShowcaseItem" ORDER BY site, "imageId"`
    );
    expect(rows).toEqual([
      { modelVersionId: VERSION, site: 'com', imageId: 3, position: 0 },
      { modelVersionId: VERSION, site: 'red', imageId: 1, position: 0 },
      { modelVersionId: VERSION, site: 'red', imageId: 2, position: 2 },
    ]);
  });

  it("keeps a removal from any merged version, over a newer live row and the target's own", async () => {
    await db.exec(`
      INSERT INTO "ModelVersion" VALUES (201, ${MODEL}), (202, ${MODEL}) ON CONFLICT DO NOTHING;
      INSERT INTO "ModelVersionShowcaseItem" ("modelVersionId", site, "imageId", source, position, removed, "addedById") VALUES
        (${VERSION}, 'red', 5, 'Community', 0, false, ${CREATOR}),
        (201, 'red', 5, 'Community', NULL, true, ${CREATOR}),
        (201, 'red', 6, 'Community', NULL, true, ${CREATOR}),
        (202, 'red', 6, 'Community', 1, false, ${CREATOR});
    `);

    await repointVersionShowcases(VERSION, [201, 202]);

    const { rows } = await db.query<{ imageId: number; removed: boolean }>(
      `SELECT "imageId", removed FROM "ModelVersionShowcaseItem" ORDER BY "imageId"`
    );
    expect(rows).toEqual([
      { imageId: 5, removed: true },
      { imageId: 6, removed: true },
    ]);
  });
});

// showcaseImageConditions restates the owner showcase's own filters for someone else's image. The
// owner query varies by viewer, so the two are not one SQL fragment; this keeps them from drifting.
describe('the community filter and the owner showcase drop the same images', () => {
  const cases: [string, string][] = [
    ['blocked', `"blockedFor" = 'tos'`],
    ['waiting on review', `"needsReview" = 'minor'`],
    ['an accepted minor', `"acceptableMinor" = true`],
    ['unrated', `"nsfwLevel" = 0`],
    ['not yet scanned', `ingestion = 'Pending'`],
    ['a TOS violation', `"tosViolation" = true`],
    ['mature on a restricted base model', `"nsfwLevel" = 4, "modelRestricted" = true`],
  ];

  it.each(cases)('%s', async (_name, change) => {
    // An owner image and a community image, each with the same problem, beside clean controls.
    await db.query(
      `INSERT INTO "Post" (id, "userId", "modelVersionId", "publishedAt") VALUES (900, $1, $2, now())`,
      [CREATOR, VERSION]
    );
    await db.query(
      `INSERT INTO "Image" (id, "userId", "postId", "nsfwLevel", index) VALUES (901, $1, 900, 1, 0), (902, $1, 900, 1, 1)`,
      [CREATOR]
    );
    await db.query(`UPDATE "Image" SET ${change} WHERE id = 902`);
    const clean = await featured();
    const bad = await featured();
    await db.query(`UPDATE "Image" SET ${change} WHERE id = $1`, [bad]);

    const owner = await getImagesForModelVersion({
      modelVersionIds: [VERSION],
      imagesPerVersion: 20,
    });
    expect(owner.map((image) => image.id)).toEqual([901]);
    expect(await served()).toEqual([clean]);
  });
});

describe('while showcases are paused (the serve kill switch is off)', () => {
  const pause = () => {
    flipt.paused = true;
    resetFeatureFlagsStateVersionCacheForTests();
  };

  it("serves the creator's own list and keeps the curated rows for when it is back on", async () => {
    const id = await featured();
    pause();
    expect(await getVersionShowcases([VERSION])).toEqual({});
    const owner = { [VERSION]: { images: [{ id: 1 }] } } as never;
    expect(await withCuratedShowcases(owner, 'red')).toEqual(owner);

    flipt.paused = false;
    resetFeatureFlagsStateVersionCacheForTests();
    expect(await served()).toEqual([id]);
  });

  it('keeps a community cover that would otherwise be cleared, and readers skip it', async () => {
    const banned = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [banned, MODEL]);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [banned]);
    pause();

    await dropInvalidCommunityCovers([MODEL]);

    expect(await redCover()).toBe(banned);
    expect((await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: banned }])).size).toBe(0);
  });
});
