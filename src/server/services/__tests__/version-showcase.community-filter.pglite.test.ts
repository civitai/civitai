import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The version showcase's community images, run through the cache's real lookup SQL against PGlite.
 * Each refused image sits beside a clean control, so a filter that drops everything fails too.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const gallery = vi.hoisted(() => ({ settings: null as unknown }));
vi.mock('~/server/services/model.service', () => ({
  getGallerySettingsByModelId: async () => gallery.settings,
}));
// A plain in-memory cache over the real lookup: entries stay until refreshed, like Redis does, so a
// read that wrongly trusts the cache shows up as stale.
const cacheStore = vi.hoisted(() => new Map<number, unknown>());
vi.mock('~/server/utils/cache-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createCachedObject: (options: {
    lookupFn: (ids: number[], fromWrite?: boolean) => Promise<Record<number, unknown>>;
  }) => {
    const load = async (ids: number[]) => {
      if (!ids.length) return;
      const records = await options.lookupFn(ids, true);
      for (const id of ids) cacheStore.set(id, records[id]);
    };
    return {
      fetch: async (ids: number[]) => {
        await load(ids.filter((id) => !cacheStore.has(id)));
        return Object.fromEntries(ids.map((id) => [id, cacheStore.get(id)]));
      },
      refresh: (ids: number[]) => load(ids),
    };
  },
}));
const saveModelCovers = vi.hoisted(() => vi.fn(async (_args: unknown) => true));
vi.mock('~/server/services/model-cover.service', () => ({ saveModelCovers }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  preventReplicationLagBatch: vi.fn(async () => undefined),
}));
vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

const {
  getVersionShowcases,
  bustVersionShowcasesForUser,
  getShowcaseCommunityCovers,
  dropInvalidCommunityCovers,
  repointVersionShowcases,
} = await import('../version-showcase.service');
const { getImagesForModelVersion } = await import('../image.service');

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
      nsfw boolean NOT NULL DEFAULT false
    );
    CREATE TABLE "ModelVersion" (id int PRIMARY KEY, "modelId" int NOT NULL);
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
  dbMock.dbWrite.modelVersion.findMany.mockResolvedValue([
    { id: VERSION, modelId: MODEL },
  ] as never);
});
afterAll(() => db.close());

beforeEach(async () => {
  gallery.settings = null;
  cacheStore.clear();
  saveModelCovers.mockClear();
  await db.exec(`
    DELETE FROM "ModelVersionShowcaseItem"; DELETE FROM "Image"; DELETE FROM "Post";
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
    gallery.settings = {
      hiddenImages: { [VERSION]: [hiddenImage] },
      hiddenUsers: [{ id: hiddenUser }],
      sfwHeld: true,
      level: PG,
    };
    expect(await served()).toEqual([clean]);
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

    expect(saveModelCovers).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: MODEL, covers: { coverImageId: null } })
    );
  });

  it('judges a cover against the current state when its showcase cache is stale', async () => {
    const banned = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [banned, MODEL]);
    expect(await served()).toContain(banned);
    await db.query(`UPDATE "User" SET "bannedAt" = now() WHERE id = $1`, [banned]);

    await dropInvalidCommunityCovers([MODEL]);

    expect(saveModelCovers).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: MODEL, covers: { coverImageId: null } })
    );
  });

  it("clears a mature model's community .com cover, and keeps its .red one", async () => {
    const com = await featured({ site: 'com' });
    const red = await featured();
    await db.query(
      `UPDATE "Model" SET nsfw = true, "sfwCoverImageId" = $1, "coverImageId" = $2 WHERE id = $3`,
      [com, red, MODEL]
    );

    await dropInvalidCommunityCovers([MODEL]);

    expect(saveModelCovers).toHaveBeenCalledTimes(1);
    expect(saveModelCovers).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: MODEL, covers: { sfwCoverImageId: null } })
    );
  });

  it('leaves a community cover whose author is still in good standing', async () => {
    const fine = await featured();
    await db.query(`UPDATE "Model" SET "coverImageId" = $1 WHERE id = $2`, [fine, MODEL]);

    await bustVersionShowcasesForUser(fine);

    expect(saveModelCovers).not.toHaveBeenCalled();
  });

  it('a deleted image stops counting as a cover at once', async () => {
    const id = await featured();
    const before = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);
    await db.query(`DELETE FROM "Image" WHERE id = $1`, [id]);
    const after = await getShowcaseCommunityCovers([{ modelId: MODEL, imageId: id }]);

    expect(before.size).toBe(1);
    expect(after.size).toBe(0);
  });

  it("doesn't count a row featured on another model", async () => {
    const id = await featured();
    const covers = await getShowcaseCommunityCovers([{ modelId: MODEL + 1, imageId: id }]);
    expect(covers.size).toBe(0);
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
