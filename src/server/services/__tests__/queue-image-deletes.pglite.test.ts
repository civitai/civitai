import { PGlite } from '@electric-sql/pglite';
import {
  cleanupBlocked,
  deleteImageRows,
  IMAGE_USES,
  imageNotUsed,
  queueImageDeletes,
  queueImageStorageDelete,
  readDueDeletes,
  settleDeletes,
} from '@civitai/db-queries/content-deletion';
import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { Prisma } from '@prisma/client';
import { sql } from 'kysely';
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
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM (
      'PendingDelete', 'ImageStorageDelete', 'UpdateNsfwLevel', 'CdnAccessSync'
    );
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(), UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
  // Returned by `deleteImageRows`.
  await pg.exec(`ALTER TABLE "Image" ADD COLUMN metadata jsonb`);
});
afterAll(() => pg.close());

beforeEach(async () => {
  const tables = [
    'JobQueue',
    'Image',
    'ImageReport',
    'Report',
    'CsamReport',
    'CsamQueueSetAside',
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
      `SELECT "entityId", data FROM "JobQueue" WHERE type = 'PendingDelete' ORDER BY "entityId"`
    )
  ).rows;

const CLEANUP = { cleanup: true };

const queue = (ids: number[], moderatorDelete?: boolean) =>
  queueImageDeletes(db, ids, { ownerId: OWNER, moderatorDelete });

describe('queueImageDeletes', () => {
  it("queues the owner's own image that nothing uses", async () => {
    await addImage(1);

    await queue([1]);

    expect(await queued()).toEqual([{ entityId: 1, data: CLEANUP }]);
  });

  it.each([
    ["someone else's", { userId: SOMEONE_ELSE }],
    ['in a post', { postId: 500 }],
  ])('skips an image %s', async (_, over) => {
    await addImage(1, over);

    await queue([1]);

    expect(await queued()).toEqual([]);
  });

  // The job waits on moderation (`cleanupBlocked`); the queue only says the parent is done with it.
  it('queues an image under moderation', async () => {
    await addImage(1, { needsReview: 'csam' });
    await addImage(2, { blockedFor: 'tos' });

    await queue([1, 2]);

    expect(await queued()).toEqual([
      { entityId: 1, data: CLEANUP },
      { entityId: 2, data: CLEANUP },
    ]);
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

    expect(await queued()).toEqual([{ entityId: 1, data: CLEANUP }]);
  });

  it("queues each image once, adding a moderator's flag but never taking it off", async () => {
    await addImage(1);
    await addImage(2);
    await queue([1, 1, 2]);

    await queue([1], true);
    await queue([1]);

    expect(await queued()).toEqual([
      { entityId: 1, data: { ...CLEANUP, moderatorDelete: true } },
      { entityId: 2, data: CLEANUP },
    ]);
  });

  it('leaves an image linked again after it was queued to the delete', async () => {
    await addImage(1);
    await addImage(2);
    await queue([1, 2]);
    await pg.exec(`INSERT INTO "Article" ("coverId") VALUES (1)`);

    const deleted = await deleteImageRows(db, {
      ids: [1, 2],
      actor: { system: 'test' },
      where: imageNotUsed(),
    });

    expect(deleted.map((row) => row.id)).toEqual([2]);
  });
});

// Every part of the child-safety case: pending-deletes.pglite.test.ts.
describe('cleanupBlocked', () => {
  const waits = async (moderatorDelete: boolean) =>
    (
      await sql<{ id: number }>`SELECT id FROM "Image" WHERE ${cleanupBlocked(
        moderatorDelete,
        sql<boolean>`false`
      )} ORDER BY id`.execute(db)
    ).rows.map((row) => row.id);
  const report = (id: number, reason: string, status = 'Pending') =>
    pg.exec(`INSERT INTO "Report" (id, reason, status) VALUES (${id}, '${reason}', '${status}');
      INSERT INTO "ImageReport" ("imageId", "reportId") VALUES (${id}, ${id})`);

  it.each([
    ['awaiting review', { needsReview: 'minor' }, false],
    ['blocked', { ingestion: 'Blocked' }, false],
    ['rated blocked', { nsfwLevel: 32 }, false],
    ['blocked for a reason', { blockedFor: 'tos' }, false],
    ['under CSAM review', { needsReview: 'csam' }, true],
  ])(
    "keeps an owner's cleanup of an image %s, and a moderator's only for CSAM",
    async (_, over, csam) => {
      await addImage(1, over);

      expect(await waits(false)).toEqual([1]);
      expect(await waits(true)).toEqual(csam ? [1] : []);
    }
  );

  it("keeps an owner's cleanup while any report is open, and only until it is ruled on", async () => {
    await addImage(1);
    await addImage(2);
    await addImage(3);
    await report(1, 'TOSViolation');
    await report(2, 'TOSViolation', 'Actioned');
    await report(3, 'CSAM', 'Processing');

    expect(await waits(false)).toEqual([1, 3]);
    expect(await waits(true)).toEqual([3]);
  });

  it('lets a cleanup of an image the CSAM queue dismissed go', async () => {
    await addImage(1, { needsReview: 'csam' });
    await pg.exec(`INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES (1, 'Dismissed')`);

    expect([await waits(false), await waits(true)]).toEqual([[], []]);
  });
});

describe('readDueDeletes and settleDeletes', () => {
  const QUEUE = 'Image';
  const rows = async () =>
    (
      await pg.query<{ entityId: number; type: string; data: Record<string, unknown> }>(
        `SELECT "entityId", type::text AS type, CASE WHEN "createdAt" > now() THEN data || '{"waiting": true}' ELSE data END AS data
         FROM "JobQueue" ORDER BY "entityId", type`
      )
    ).rows;

  beforeEach(async () => {
    for (const id of [1, 2, 3, 4]) await addImage(id);
    await queue([1, 2, 3, 4]);
    await queueImageStorageDelete(db, { id: 1, url: 'a' });
  });

  it("settles each delete one way and leaves other queues' rows alone", async () => {
    await settleDeletes(db, QUEUE, { done: [1], waiting: [2], failed: [3] });

    const after = await rows();
    expect(after.map((row) => [row.entityId, row.type])).toEqual([
      [1, 'ImageStorageDelete'],
      [2, 'PendingDelete'],
      [3, 'PendingDelete'],
      [4, 'PendingDelete'],
    ]);
    expect(after[1].data).toEqual({ ...CLEANUP, waiting: true });
    expect(after[2].data).toEqual({ ...CLEANUP, attempted: true });
  });

  it('holds back a waiting delete until its time comes, and takes retries after first attempts', async () => {
    await settleDeletes(db, QUEUE, { waiting: [2], failed: [1] });

    expect((await readDueDeletes(db, QUEUE, 10)).map((row) => [row.id, row.attempted])).toEqual([
      [3, false],
      [4, false],
      [1, true],
    ]);

    await pg.exec(`UPDATE "JobQueue" SET "createdAt" = now()
      WHERE "entityId" = 2 AND type = 'PendingDelete'`);
    expect((await readDueDeletes(db, QUEUE, 10)).map((row) => row.id)).toContain(2);
  });

  it("waits an hour for a cleanup, and one run for an owner's delete", async () => {
    // Four minutes: due again by the next run of a job every five.
    await pg.exec(`INSERT INTO "JobQueue" ("entityId", "entityType", type, data)
      VALUES (9, 'Image', 'PendingDelete', '{"ownerId": 7}')`);

    await settleDeletes(db, QUEUE, { waiting: [2, 9] });

    const { rows: due } = await pg.query<{ entityId: number; minutes: number }>(
      `SELECT "entityId", round(extract(epoch FROM "createdAt" - now()) / 60)::int AS minutes
       FROM "JobQueue" WHERE "entityId" IN (2, 9) AND type = 'PendingDelete' ORDER BY "entityId"`
    );
    expect(due).toEqual([
      { entityId: 2, minutes: 60 },
      { entityId: 9, minutes: 4 },
    ]);
  });

  it('retries a once-waiting delete that then fails on the next run, not after another wait', async () => {
    await settleDeletes(db, QUEUE, { waiting: [2] });
    // Due, and taken.
    await pg.exec(`UPDATE "JobQueue" SET "createdAt" = now() WHERE "entityId" = 2`);
    await settleDeletes(db, QUEUE, { failed: [2] });

    expect((await readDueDeletes(db, QUEUE, 10)).find((row) => row.id === 2)).toEqual({
      id: 2,
      data: { ...CLEANUP, attempted: true },
      attempted: true,
    });
  });

  it('takes a failed delete that then waits as a first attempt again', async () => {
    await settleDeletes(db, QUEUE, { failed: [2] });
    await settleDeletes(db, QUEUE, { waiting: [2] });
    await pg.exec(`UPDATE "JobQueue" SET "createdAt" = now() WHERE "entityId" = 2`);

    expect((await readDueDeletes(db, QUEUE, 10)).find((row) => row.id === 2)).toEqual({
      id: 2,
      data: CLEANUP,
      attempted: false,
    });
  });
});

/**
 * Relations of `Image` that are part of the image itself, or one of the conditions above, not a
 * place it is shown: they go when the image goes, so they cannot make it "in use".
 */
const NOT_A_USE: Record<string, string> = {
  user: 'the owner, checked by userId',
  post: 'checked by postId',
  reports: 'an open report makes the cleanup wait on its own',
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
