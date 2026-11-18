import { PGlite } from '@electric-sql/pglite';
import {
  dequeueImageDeletes,
  IMAGE_USES,
  queueImageDeletes,
  queueImageStorageDelete,
} from '@civitai/db-queries/content-deletion';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteKysely } from '~/__tests__/pglite-kysely';

vi.setConfig({ hookTimeout: 60_000 });

const OWNER = 7;
const SOMEONE_ELSE = 8;
const SHOP_KEY = '0a0b0c0d-0000-4000-8000-0000000000aa';

let pg: PGlite;
const db = pgliteKysely(() => pg);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "EntityType" AS ENUM ('Image');
    CREATE TYPE "JobQueueType" AS ENUM ('ImageDelete', 'ImageStorageDelete');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
});
afterAll(() => pg.close());

beforeEach(async () => {
  const tables = [
    'JobQueue',
    'Image',
    'ImageReport',
    'Report',
    'CsamReport',
    'Cosmetic',
    'CosmeticShopItem',
    'ItemDefinition',
    'ImageCdnShopTakedown',
    ...new Set(Object.values(IMAGE_USES).map(([table]) => table)),
  ];
  await pg.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')}`);
});

const addImage = (id: number, over: Record<string, unknown> = {}) => {
  const image = {
    id,
    userId: OWNER,
    url: `0a0b0c0d-0000-4000-8000-${String(id).padStart(12, '0')}`,
    ...over,
  };
  const columns = Object.keys(image);
  return pg.query(
    `INSERT INTO "Image" (${columns.map((c) => `"${c}"`).join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(image)
  );
};

const queued = async () =>
  (
    await pg.query<{ entityId: number; data: unknown }>(
      `SELECT "entityId", data FROM "JobQueue" WHERE type = 'ImageDelete' ORDER BY "entityId"`
    )
  ).rows;

const queue = (ids: number[], moderatorDelete?: boolean) =>
  queueImageDeletes(db, ids, { ownerId: OWNER, moderatorDelete });

describe('queueImageDeletes', () => {
  it("queues the owner's own image that nothing uses", async () => {
    await addImage(1);

    await queue([1]);

    expect(await queued()).toEqual([{ entityId: 1, data: {} }]);
  });

  it.each([
    ["someone else's", { userId: SOMEONE_ELSE }],
    ['in a post', { postId: 500 }],
    ['awaiting review', { needsReview: 'minor' }],
    ['blocked', { ingestion: 'Blocked' }],
    ['rated blocked', { nsfwLevel: 32 }],
    ['blocked for a reason', { blockedFor: 'tos' }],
  ])('skips an image %s', async (_, over) => {
    await addImage(1, over);

    await queue([1]);

    expect(await queued()).toEqual([]);
  });

  it('skips a reported image', async () => {
    await addImage(1);
    await pg.exec(`INSERT INTO "ImageReport" ("imageId") VALUES (1)`);

    await queue([1]);

    expect(await queued()).toEqual([]);
  });

  it.each(Object.entries(IMAGE_USES))(
    'skips an image still used by %s',
    async (_, [table, column]) => {
      await addImage(1);
      await pg.exec(`INSERT INTO "${table}" ("${column}") VALUES (1)`);

      await queue([1]);

      expect(await queued()).toEqual([]);
    }
  );

  // Deleting the image deletes its stored object, which the shop artwork still shows.
  it.each([
    [
      'a shop cosmetic',
      `INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url": "${SHOP_KEY}"}');
       INSERT INTO "CosmeticShopItem" ("cosmeticId") VALUES (1)`,
    ],
    [
      'a shop item cover',
      `INSERT INTO "CosmeticShopItem" (meta) VALUES ('{"coverUrl": "https://x/${SHOP_KEY.toUpperCase()}"}')`,
    ],
    ['an item definition', `INSERT INTO "ItemDefinition" ("imageUrl") VALUES ('${SHOP_KEY}')`],
    ['a taken-down listing', `INSERT INTO "ImageCdnShopTakedown" (url) VALUES ('${SHOP_KEY}')`],
  ])('skips an image whose key %s uses', async (_, insert) => {
    await addImage(1, { url: SHOP_KEY });
    await pg.exec(insert);

    await queue([1]);

    expect(await queued()).toEqual([]);
  });

  it('queues an image whose key only a cosmetic outside the shop uses', async () => {
    await addImage(1, { url: SHOP_KEY });
    await pg.exec(`INSERT INTO "Cosmetic" (id, data) VALUES (1, '{"url": "${SHOP_KEY}"}')`);

    await queue([1]);

    expect(await queued()).toEqual([{ entityId: 1, data: {} }]);
  });

  it("queues each image once, adding a moderator's flag but never taking it off", async () => {
    await addImage(1);
    await addImage(2);
    await queue([1, 1, 2]);

    await queue([1], true);
    await queue([1]);

    expect(await queued()).toEqual([
      { entityId: 1, data: { moderatorDelete: true } },
      { entityId: 2, data: {} },
    ]);
  });

  describe("a moderator's delete", () => {
    it.each([
      ['awaiting review', { needsReview: 'minor' }],
      ['blocked', { ingestion: 'Blocked', blockedFor: 'tos', nsfwLevel: 32 }],
    ])('queues an image %s', async (_, over) => {
      await addImage(1, over);

      await queue([1], true);

      expect(await queued()).toEqual([{ entityId: 1, data: { moderatorDelete: true } }]);
    });

    it('queues an image reported for something other than CSAM', async () => {
      await addImage(1);
      await pg.exec(`INSERT INTO "Report" (id, reason) VALUES (1, 'TOSViolation');
        INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (1, 1)`);

      await queue([1], true);

      expect(await queued()).toEqual([{ entityId: 1, data: { moderatorDelete: true } }]);
    });

    it.each([
      ['under CSAM review', () => addImage(1, { needsReview: 'csam' })],
      ['blocked for CSAM', () => addImage(1, { blockedFor: 'CSAM' })],
      [
        'reported for CSAM',
        async () => {
          await addImage(1);
          await pg.exec(`INSERT INTO "Report" (id, reason) VALUES (1, 'CSAM');
            INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (1, 1)`);
        },
      ],
      ...['[{"id": 1}]', '[1]', '["1"]'].map(
        (images) =>
          [
            `listed in a CSAM report as ${images}`,
            async () => {
              await addImage(1);
              await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('${images}')`);
            },
          ] as const
      ),
    ])('skips an image %s', async (_, setup) => {
      await setup();
      // A malformed report holds nothing back, and does not stop the rest.
      await pg.exec(`INSERT INTO "CsamReport" (images) VALUES ('{}'), ('[null]')`);
      await addImage(2);

      await queue([1, 2], true);

      expect(await queued()).toEqual([{ entityId: 2, data: { moderatorDelete: true } }]);
    });

    it('still skips an image someone else uses', async () => {
      await addImage(1, { postId: 500 });
      await addImage(2);
      await pg.exec(`INSERT INTO "ImageConnection" ("imageId") VALUES (2)`);

      await queue([1, 2], true);

      expect(await queued()).toEqual([]);
    });
  });

  it("dequeues only the listed images' delete rows", async () => {
    await addImage(1);
    await addImage(2);
    await queue([1, 2]);
    await queueImageStorageDelete(db, { id: 1, url: 'a' });

    await dequeueImageDeletes(db, [1]);

    expect(await queued()).toEqual([{ entityId: 2, data: {} }]);
    const storage = await pg.query(`SELECT 1 FROM "JobQueue" WHERE type = 'ImageStorageDelete'`);
    expect(storage.rows).toHaveLength(1);
  });
});

/**
 * Relations of `Image` that are part of the image itself, or one of the conditions above, not a
 * place it is shown: they go when the image goes, so they cannot make it "in use".
 */
const NOT_A_USE: Record<string, string> = {
  user: 'the owner, checked by userId',
  post: 'checked by postId',
  reports: 'a reported image is skipped on its own',
  reactions: 'reactions to this image',
  thread: 'comments on this image',
  tags: 'its tags',
  tagVotes: 'votes on its tags',
  tagComposites: 'its tag view',
  modHelper: 'moderation scratch data',
  resources: 'resources detected in it',
  resourceHelper: 'its resource view',
  engagements: 'engagement with this image',
  tools: 'tools it records',
  techniques: 'techniques it records',
  flags: 'its scan flags',
  ratingRequests: 'rating requests for it',
  tagsNew: 'its tags',
  imageResourceNew: 'resources detected in it',
  imageTagsForReview: 'tags queued for review on it',
  caption: 'its storyline caption',
};

describe('IMAGE_USES', () => {
  const { models } = Prisma.dmmf.datamodel;
  const image = models.find((m) => m.name === 'Image');
  const relations = image?.fields.filter((f) => f.kind === 'object') ?? [];

  it('names every Image relation, as a place the image is used or as part of the image', () => {
    const named = relations.filter((r) => !(r.name in IMAGE_USES) && !(r.name in NOT_A_USE));

    // A new relation that shows an image elsewhere belongs in `IMAGE_USES`, or the cleanup deletes
    // an image that relation still shows.
    expect(named.map((r) => r.name)).toEqual([]);
    expect(relations.length).toBeGreaterThan(Object.keys(NOT_A_USE).length);
  });

  it('names the table and column each relation points at the image with', () => {
    const actual = Object.fromEntries(
      relations
        .filter((r) => r.name in IMAGE_USES)
        .map((r) => {
          const model = models.find((m) => m.name === r.type);
          const back = model?.fields.find(
            (f) => f.relationName === r.relationName && f.type === 'Image'
          );
          const column = model?.fields.find((f) => f.name === back?.relationFromFields?.[0]);
          return [r.name, [model?.dbName ?? model?.name, column?.dbName ?? column?.name]];
        })
    );

    expect(actual).toEqual(IMAGE_USES);
  });
});
