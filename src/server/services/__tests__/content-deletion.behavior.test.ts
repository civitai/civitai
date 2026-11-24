import { imageUseTablesSql } from '@civitai/db-queries/test/image-uses';
import { PGlite } from '@electric-sql/pglite';
import {
  deleteImageRows,
  deletePostRows,
  moderatorPurge,
  queueImageStorageDelete,
  queuePostNsfwLevelUpdates,
} from '@civitai/db-queries/content-deletion';
import { sql } from 'kysely';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';
import { kyselyOver } from '~/server/db/prisma-kysely';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const OWNER = 7;
const OTHER = 8;
let pg: PGlite;
const db = () => kyselyOver({ $queryRaw: pgliteRaw(pg).queryRaw } as never);

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE "Post" (id int PRIMARY KEY, "userId" int NOT NULL, "nsfwLevel" int NOT NULL DEFAULT 1,
      "publishedAt" timestamp, metadata jsonb);
    CREATE TABLE "Image" (
      id int PRIMARY KEY, url text NOT NULL, "userId" int NOT NULL, "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 1, ingestion text NOT NULL DEFAULT 'Scanned',
      "needsReview" text, "blockedFor" text, metadata jsonb
    );
    CREATE TYPE "EntityType" AS ENUM ('Image', 'Post');
    CREATE TYPE "JobQueueType" AS ENUM ('PendingDelete', 'ImageStorageDelete', 'CdnAccessSync', 'UpdateNsfwLevel', 'ImageDelete');
    CREATE TABLE "JobQueue" (
      "entityId" int NOT NULL, "entityType" "EntityType" NOT NULL, type "JobQueueType" NOT NULL,
      data jsonb, "createdAt" timestamp NOT NULL DEFAULT now(),
      UNIQUE ("entityType", "entityId", type)
    );
  `);
  await pg.exec(imageUseTablesSql);
});

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE "Image", "Post", "JobQueue", "CsamQueueSetAside";
    INSERT INTO "Post" VALUES (10, ${OWNER}), (11, ${OTHER});
    INSERT INTO "Image" (id, url, "userId", "postId", metadata) VALUES
      (1, 'a', ${OWNER}, 10, '{"parentId": 900}'),
      (2, 'b', ${OTHER}, 10, '{"parentId": "not-an-id"}'),
      (3, 'c', ${OWNER}, NULL, '{"parentId": "2147483647"}');
  `);
});

const remaining = async (table: 'Image' | 'Post') =>
  (await pg.query<{ id: number }>(`SELECT id FROM "${table}" ORDER BY id`)).rows.map((r) => r.id);

describe('deleteImageRows', () => {
  it("deletes only a member's own images", async () => {
    const { deleted: rows } = await deleteImageRows(db(), {
      ids: [1, 2],
      actor: { id: OWNER, isModerator: false },
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
    expect(await remaining('Image')).toEqual([2, 3]);
  });

  it.each([
    ['a moderator', { id: OWNER, isModerator: true }],
    ['a system caller', { system: 'test' }],
  ])("lets %s delete anyone's images", async (_, actor) => {
    await deleteImageRows(db(), { ids: [1, 2], actor });
    expect(await remaining('Image')).toEqual([3]);
  });

  it("keeps the rows the caller's condition excludes", async () => {
    const { deleted: rows } = await deleteImageRows(db(), {
      ids: [1, 2, 3],
      actor: { system: 'test' },
      where: sql<boolean>`"postId" IS NOT NULL`,
    });
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(await remaining('Image')).toEqual([3]);
  });

  it("still limits a member to their own images under the caller's condition", async () => {
    const { deleted: rows } = await deleteImageRows(db(), {
      ids: [1, 2, 3],
      actor: { id: OWNER, isModerator: false },
      where: sql<boolean>`"postId" IS NOT NULL`,
    });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it('returns what the follow-up needs, with a malformed thumbnail parent as null and the largest id kept', async () => {
    const { deleted: rows } = await deleteImageRows(db(), {
      ids: [1, 2, 2, 3],
      actor: { system: 'test' },
    });
    expect(rows.sort((a, b) => a.id - b.id)).toEqual([
      expect.objectContaining({ id: 1, url: 'a', userId: OWNER, postId: 10, parentId: 900 }),
      expect.objectContaining({ id: 2, ingestion: 'Scanned', parentId: null }),
      expect.objectContaining({ id: 3, parentId: 2147483647 }),
    ]);
  });

  it('refuses a condition with "$<digit>" in a literal rather than binding values out of place', async () => {
    await expect(
      deleteImageRows(db(), {
        ids: [1],
        actor: { system: 'test' },
        where: sql<boolean>`url <> '$1'`,
      })
    ).rejects.toThrow('outside its placeholders');
    expect(await remaining('Image')).toEqual([1, 2, 3]);
  });

  it('takes more ids than one statement could bind one by one', async () => {
    const ids = [...Array.from({ length: 70_000 }, (_, i) => 100_000 + i), 1];
    const { deleted: rows } = await deleteImageRows(db(), { ids, actor: { system: 'test' } });
    expect(rows.map((r) => r.id)).toEqual([1]);
  });

  it('sends nothing for no ids', async () => {
    const queryRaw = vi.fn();
    expect(
      await deleteImageRows(kyselyOver({ $queryRaw: queryRaw } as never), {
        ids: [],
        actor: { system: 'test' },
      })
    ).toEqual({ deleted: [], kept: [], hidden: [], gone: [] });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('deletePostRows', () => {
  it("deletes only a member's own posts", async () => {
    const { deleted: rows } = await deletePostRows(db(), {
      ids: [10, 11],
      actor: { id: OWNER, isModerator: false },
    });
    expect(rows).toEqual([{ id: 10, userId: OWNER, nsfwLevel: 1 }]);
    expect(await remaining('Post')).toEqual([11]);
  });

  it("lets a moderator delete anyone's posts, and keeps those the condition excludes", async () => {
    await deletePostRows(db(), {
      ids: [10, 11],
      actor: { id: OWNER, isModerator: true },
      where: sql<boolean>`"userId" <> ${OWNER}`,
    });
    expect(await remaining('Post')).toEqual([10]);
  });
});

const queued = async () =>
  (
    await pg.query<{ entityId: number; entityType: string; type: string; data: unknown }>(
      `SELECT "entityId", "entityType", type, data FROM "JobQueue" ORDER BY type, "entityId"`
    )
  ).rows;

// The DELETE and what it queues are one statement, so a deleted row always leaves its file queued and
// a kept row queues nothing, with no transaction around it.
describe('deleteImageRows queueing in the same statement', () => {
  // Every version unless under CSAM review; shop artwork kept only for the owner's images.
  const files = {
    allVersions: moderatorPurge,
    keepShopArtwork: sql<boolean>`"userId" = ${OWNER}`,
  };
  const SYSTEM = { system: 'test' };
  const queuedOf = async (type: 'ImageStorageDelete' | 'UpdateNsfwLevel') =>
    (await queued()).filter((row) => row.type === type);

  it("queues each deleted file with the flags its own row's conditions give, and returns them", async () => {
    // Dismissed, so no open case keeps it.
    await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 2;
        INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES (2, 'Dismissed')`);

    const { deleted: rows } = await deleteImageRows(db(), { ids: [1, 2, 3], actor: SYSTEM, files });

    expect(
      (await queuedOf('ImageStorageDelete')).map(({ entityId, data }) => [entityId, data])
    ).toEqual([
      [1, { url: 'a', allVersions: true, keepShopArtwork: true }],
      [2, { url: 'b' }],
      [3, { url: 'c', allVersions: true, keepShopArtwork: true }],
    ]);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.allVersions]))).toEqual({
      1: true,
      2: false,
      3: true,
    });
  });

  it('queues no file and no recount for a row the member limit keeps', async () => {
    await pg.exec(`UPDATE "Image" SET "postId" = 11 WHERE id = 2`);
    await deleteImageRows(db(), {
      ids: [1, 2],
      actor: { id: OWNER, isModerator: false },
      files,
      recountPosts: true,
    });
    expect((await queuedOf('ImageStorageDelete')).map((row) => row.entityId)).toEqual([1]);
    expect((await queuedOf('UpdateNsfwLevel')).map((row) => row.entityId)).toEqual([10]);
  });

  it("queues no file and no recount for a row the caller's condition keeps", async () => {
    await deleteImageRows(db(), {
      ids: [1, 2, 3],
      actor: SYSTEM,
      where: sql<boolean>`"postId" IS NULL`,
      files,
      recountPosts: true,
    });
    expect((await queuedOf('ImageStorageDelete')).map((row) => row.entityId)).toEqual([3]);
    expect(await queuedOf('UpdateNsfwLevel')).toEqual([]);
  });

  it('queues each post of the deleted rows once, only when asked', async () => {
    await deleteImageRows(db(), { ids: [1], actor: SYSTEM });
    expect(await queuedOf('UpdateNsfwLevel')).toEqual([]);

    // Images 2 and 4 are both on post 10.
    await pg.exec(
      `INSERT INTO "Image" (id, url, "userId", "postId") VALUES (4, 'd', ${OWNER}, 10)`
    );
    await deleteImageRows(db(), { ids: [2, 3, 4], actor: SYSTEM, recountPosts: true });
    expect(await queuedOf('UpdateNsfwLevel')).toEqual([
      { entityId: 10, entityType: 'Post', type: 'UpdateNsfwLevel', data: null },
    ]);
  });

  // A recount run that read the row before this delete then leaves it for the next run, so the row
  // is re-dated by the clock: `now()` would give it the transaction's start, which that run's read
  // can follow.
  it('re-dates a recount already queued for the post past its own transaction start', async () => {
    await pg.exec(`
      INSERT INTO "JobQueue" ("entityId", "entityType", type, "createdAt")
      VALUES (10, 'Post', 'UpdateNsfwLevel', '2000-01-01')
    `);
    await pg.exec('BEGIN');
    try {
      await pg.exec('SELECT pg_sleep(0.05)');
      await deleteImageRows(db(), { ids: [1], actor: SYSTEM, recountPosts: true });
      const { rows } = await pg.query<{ afterStart: boolean }>(
        `SELECT "createdAt" > now()::timestamp AS "afterStart" FROM "JobQueue" WHERE type = 'UpdateNsfwLevel'`
      );
      expect(rows).toEqual([{ afterStart: true }]);
    } finally {
      await pg.exec('ROLLBACK');
    }
  });

  describe('with cdnTakedown', () => {
    const cdnRows = async () => (await queued()).filter((row) => row.type === 'CdnAccessSync');

    it("queues a moderator's takedown of each deleted url, its owner and CSAM review travelling with it", async () => {
      // Dismissed, so no open case keeps it.
      await pg.exec(`UPDATE "Image" SET "needsReview" = 'csam' WHERE id = 2;
        INSERT INTO "CsamQueueSetAside" ("imageId", outcome) VALUES (2, 'Dismissed')`);

      await deleteImageRows(db(), { ids: [1, 2], actor: SYSTEM, cdnTakedown: true });

      expect(
        (await cdnRows()).map(({ entityId, data }) => {
          const { seq, ...rest } = data as Record<string, unknown>;
          expect(seq).toBeDefined();
          return [entityId, rest];
        })
      ).toEqual([
        [1, { url: 'a', userId: OWNER, csamReview: false, moderatorDelete: true }],
        [2, { url: 'b', userId: OTHER, csamReview: true, moderatorDelete: true }],
      ]);
    });

    it('queues none without the flag, and none for a row the delete keeps', async () => {
      await deleteImageRows(db(), { ids: [1], actor: SYSTEM });
      await deleteImageRows(db(), {
        ids: [2],
        actor: { id: OWNER, isModerator: false },
        cdnTakedown: true,
      });
      expect(await cdnRows()).toEqual([]);
    });

    it('merges onto a sync already queued for the image', async () => {
      await pg.exec(`
        INSERT INTO "JobQueue" ("entityId", "entityType", type, data)
        VALUES (1, 'Image', 'CdnAccessSync', '{"earlier": true}')
      `);
      await deleteImageRows(db(), { ids: [1], actor: SYSTEM, cdnTakedown: true });
      expect((await cdnRows())[0].data).toMatchObject({
        earlier: true,
        moderatorDelete: true,
        url: 'a',
      });
    });
  });
});

describe('queueImageStorageDelete', () => {
  it('queues the file with only the flag it carries', async () => {
    await queueImageStorageDelete(db(), { id: 1, url: 'a', allVersions: true });
    await queueImageStorageDelete(db(), { id: 2, url: 'b', allVersions: false });
    expect(await queued()).toEqual([
      {
        entityId: 1,
        entityType: 'Image',
        type: 'ImageStorageDelete',
        data: { url: 'a', allVersions: true },
      },
      { entityId: 2, entityType: 'Image', type: 'ImageStorageDelete', data: { url: 'b' } },
    ]);
  });

  it('never downgrades a queued all-versions purge, and follows a changed key', async () => {
    await queueImageStorageDelete(db(), { id: 1, url: 'a', allVersions: true });
    await queueImageStorageDelete(db(), { id: 2, url: 'b' });
    await queueImageStorageDelete(db(), { id: 1, url: 'a' });
    await queueImageStorageDelete(db(), { id: 2, url: 'b2' });
    expect((await queued()).map((row) => row.data)).toEqual([
      { url: 'a', allVersions: true },
      { url: 'b2' },
    ]);
  });
});

describe('queuePostNsfwLevelUpdates', () => {
  it('queues each post once, alongside a row already queued', async () => {
    await queuePostNsfwLevelUpdates(db(), [10]);
    await queuePostNsfwLevelUpdates(db(), [10, 11, 11]);
    expect(await queued()).toEqual([
      { entityId: 10, entityType: 'Post', type: 'UpdateNsfwLevel', data: null },
      { entityId: 11, entityType: 'Post', type: 'UpdateNsfwLevel', data: null },
    ]);
  });
});
