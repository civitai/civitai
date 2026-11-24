import { PGlite } from '@electric-sql/pglite';
import type { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKFILL_NOTE,
  parseArgs,
  run,
  type Deps,
  type RunOptions,
} from '../oneoffs/backfill-liked-models';

const HAS_COLLECTION = 1;
const NO_COLLECTION = 2;
const LIVE = 10;
const OTHER = 11;
const DELETED = 12;
const DRAFT = 13;
const SINCE = '2026-08-19';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CollectionType" AS ENUM ('Model', 'Article', 'Post', 'Image', 'Model3D');
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TABLE "Model" (id int PRIMARY KEY, status text NOT NULL, "deletedAt" timestamp(3));
    CREATE TABLE "ResourceReview" (
      id int PRIMARY KEY, "userId" int NOT NULL, "modelId" int NOT NULL, recommended boolean NOT NULL,
      exclude boolean NOT NULL DEFAULT false, "tosViolation" boolean NOT NULL DEFAULT false,
      "createdAt" timestamp(3) NOT NULL
    );
    CREATE TABLE "Collection" (
      id serial PRIMARY KEY, "userId" int NOT NULL, name text NOT NULL, description text,
      type "CollectionType", mode "CollectionMode"
    );
    CREATE UNIQUE INDEX "User_bookmark_collection" ON "Collection" ("userId", type, mode)
      WHERE mode = 'Bookmark';
    CREATE TABLE "CollectionItem" (
      id serial PRIMARY KEY, "collectionId" int NOT NULL, "modelId" int, "addedById" int,
      "createdAt" timestamp(3), note text
    );
    CREATE UNIQUE INDEX "CollectionItem_model" ON "CollectionItem" ("collectionId", "modelId")
      WHERE "modelId" IS NOT NULL;
  `);
});

beforeEach(async () => {
  await db.exec(`
    TRUNCATE "Model", "ResourceReview", "Collection", "CollectionItem" RESTART IDENTITY;
    INSERT INTO "Model" VALUES
      (${LIVE}, 'Published', NULL), (${OTHER}, 'Published', NULL),
      (${DELETED}, 'Published', now()), (${DRAFT}, 'Draft', NULL);
    INSERT INTO "Collection" ("userId", name, type, mode) VALUES
      (${HAS_COLLECTION}, 'Liked Models', 'Model', 'Bookmark'),
      (${HAS_COLLECTION}, 'My picks', 'Model', NULL);
    INSERT INTO "CollectionItem" ("collectionId", "modelId") VALUES (1, ${OTHER});
    INSERT INTO "ResourceReview" (id, "userId", "modelId", recommended, exclude, "tosViolation", "createdAt") VALUES
      (1, ${HAS_COLLECTION}, ${LIVE}, true, false, false, '2026-06-01'),  -- before the cutoff
      (2, ${HAS_COLLECTION}, ${LIVE}, true, false, false, '2026-09-01'),  -- missing
      (3, ${HAS_COLLECTION}, ${LIVE}, true, false, false, '2026-09-02'),  -- a second version of it
      (4, ${HAS_COLLECTION}, ${OTHER}, true, false, false, '2026-09-03'), -- already liked
      (5, ${HAS_COLLECTION}, ${DELETED}, true, false, false, '2026-09-04'),
      (6, ${HAS_COLLECTION}, ${DRAFT}, true, false, false, '2026-09-05'),
      (7, ${NO_COLLECTION}, ${LIVE}, true, false, false, '2026-09-06'),   -- missing, no collection yet
      (8, ${NO_COLLECTION}, ${OTHER}, false, false, false, '2026-09-07'), -- a thumbs-down
      (9, ${NO_COLLECTION}, ${OTHER}, true, true, false, '2026-09-08'),   -- excluded
      (10, ${NO_COLLECTION}, ${DRAFT}, true, false, true, '2026-09-09');  -- TOS violation
  `);
});

const deps: Deps = {
  read: async <T>(sql: Prisma.Sql) => (await db.query<T>(sql.text, sql.values)).rows,
  write: async (sql) => (await db.query(sql.text, sql.values)).affectedRows ?? 0,
  sleep: async () => undefined,
  log: () => undefined,
};
const options = (over: Partial<RunOptions> = {}): RunOptions => ({
  ...parseArgs(['--since', SINCE, '--chunk', '3']),
  ...over,
});

const liked = async () =>
  (
    await db.query<{ userId: number; modelId: number; note: string | null }>(`
      SELECT c."userId", ci."modelId", ci.note FROM "CollectionItem" ci
      JOIN "Collection" c ON c.id = ci."collectionId" AND c.mode = 'Bookmark'
      ORDER BY 1, 2`)
  ).rows;

describe('backfill-liked-models', () => {
  it('a dry run counts the missing likes and writes nothing', async () => {
    const totals = await run(options(), deps);
    expect(totals.pairs).toBe(2);
    expect(totals.added).toBe(0);
    expect(await liked()).toEqual([{ userId: HAS_COLLECTION, modelId: OTHER, note: null }]);
  });

  it('adds each missing like once, into the bookmark collection, creating it where absent', async () => {
    const totals = await run(options({ apply: true }), deps);
    expect(totals.added).toBe(2);
    expect(await liked()).toEqual([
      { userId: HAS_COLLECTION, modelId: LIVE, note: BACKFILL_NOTE },
      { userId: HAS_COLLECTION, modelId: OTHER, note: null },
      { userId: NO_COLLECTION, modelId: LIVE, note: BACKFILL_NOTE },
    ]);
    const plain = await db.query(`SELECT 1 FROM "CollectionItem" WHERE "collectionId" = 2`);
    expect(plain.rows).toHaveLength(0);
  });

  it('a second run adds nothing', async () => {
    await run(options({ apply: true }), deps);
    const again = await run(options({ apply: true }), deps);
    expect(again).toEqual({ pairs: 0, users: 0, added: 0 });
    expect(await liked()).toHaveLength(3);
  });

  it('resumes from a cursor', async () => {
    const totals = await run(options({ apply: true, from: 6 }), deps);
    expect(totals.added).toBe(1);
    expect((await liked()).map((r) => r.userId)).toEqual([HAS_COLLECTION, NO_COLLECTION]);
  });
});
