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
const PRIVATE = 14;
const TAKEN_DOWN = 15;
const POI = 16;
const BLOCKER_OWNED = 17;
const OWN_PRIVATE = 18;
const OWNER = 50;
const BLOCKER = 51;
const OTHER_USER = 3;
const SINCE = '2026-08-19';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "CollectionType" AS ENUM ('Model', 'Article', 'Post', 'Image', 'Model3D');
    CREATE TYPE "CollectionMode" AS ENUM ('Contest', 'Bookmark');
    CREATE TABLE "Model" (
      id int PRIMARY KEY, "userId" int NOT NULL, status text NOT NULL, "deletedAt" timestamp(3),
      availability text NOT NULL DEFAULT 'Public', mode text, poi boolean
    );
    CREATE TABLE "UserEngagement" ("userId" int, "targetUserId" int, type text);
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
    TRUNCATE "Model", "UserEngagement", "ResourceReview", "Collection", "CollectionItem" RESTART IDENTITY;
    INSERT INTO "Model" (id, "userId", status, "deletedAt", availability, mode, poi) VALUES
      (${LIVE}, ${OWNER}, 'Published', NULL, 'Public', NULL, NULL),
      (${OTHER}, ${OWNER}, 'Published', NULL, 'Public', NULL, NULL),
      (${DELETED}, ${OWNER}, 'Published', now(), 'Public', NULL, NULL),
      (${DRAFT}, ${OWNER}, 'Draft', NULL, 'Public', NULL, NULL),
      (${PRIVATE}, ${OWNER}, 'Published', NULL, 'Private', NULL, NULL),
      (${TAKEN_DOWN}, ${OWNER}, 'Published', NULL, 'Public', 'TakenDown', NULL),
      (${POI}, ${OWNER}, 'Published', NULL, 'Public', NULL, true),
      (${BLOCKER_OWNED}, ${BLOCKER}, 'Published', NULL, 'Public', NULL, NULL),
      (${OWN_PRIVATE}, ${OTHER_USER}, 'Published', NULL, 'Private', NULL, NULL);
    INSERT INTO "UserEngagement" VALUES (${BLOCKER}, ${OTHER_USER}, 'Block');
    INSERT INTO "Collection" ("userId", name, type, mode) VALUES
      (${HAS_COLLECTION}, 'Liked Models', 'Model', 'Bookmark'),
      (${HAS_COLLECTION}, 'My picks', 'Model', NULL);
    INSERT INTO "CollectionItem" ("collectionId", "modelId") VALUES (1, ${OTHER});
    INSERT INTO "ResourceReview" (id, "userId", "modelId", recommended, exclude, "tosViolation", "createdAt") VALUES
      (1, ${OTHER_USER}, ${LIVE}, true, false, false, '2026-09-01'),      -- missing, below the next id
      (2, ${HAS_COLLECTION}, ${LIVE}, true, false, false, '2026-09-01'),  -- missing
      (3, ${HAS_COLLECTION}, ${LIVE}, true, false, false, '2026-09-02'),  -- a second version of it
      (4, ${HAS_COLLECTION}, ${OTHER}, true, false, false, '2026-09-03'), -- already liked
      (5, ${HAS_COLLECTION}, ${DELETED}, true, false, false, '2026-09-04'),
      (6, ${HAS_COLLECTION}, ${DRAFT}, true, false, false, '2026-09-05'),
      (7, ${NO_COLLECTION}, ${LIVE}, true, false, false, '2026-09-06'),   -- missing, no collection yet
      (8, ${NO_COLLECTION}, ${OTHER}, false, false, false, '2026-09-07'), -- a thumbs-down
      (9, ${NO_COLLECTION}, ${OTHER}, true, true, false, '2026-09-08'),   -- excluded
      (10, ${NO_COLLECTION}, ${LIVE}, true, false, true, '2026-09-09'),   -- TOS violation
      (11, ${OTHER_USER}, ${OTHER}, true, false, false, '2026-06-01'),    -- before the cutoff
      (12, ${OTHER_USER}, ${PRIVATE}, true, false, false, '2026-09-10'),
      (13, ${OTHER_USER}, ${TAKEN_DOWN}, true, false, false, '2026-09-11'),
      (14, ${OTHER_USER}, ${POI}, true, false, false, '2026-09-12'),
      (15, ${OTHER_USER}, ${BLOCKER_OWNED}, true, false, false, '2026-09-13'), -- its owner blocks them
      (16, ${OTHER_USER}, ${OWN_PRIVATE}, true, false, false, '2026-09-14');   -- their own model
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
    expect(totals.pairs).toBe(4);
    expect(totals.added).toBe(0);
    expect(await liked()).toEqual([{ userId: HAS_COLLECTION, modelId: OTHER, note: null }]);
  });

  it('adds each like the live add would accept, once, into the bookmark collection', async () => {
    const totals = await run(options({ apply: true }), deps);
    expect(totals.added).toBe(4);
    expect(await liked()).toEqual([
      { userId: HAS_COLLECTION, modelId: LIVE, note: BACKFILL_NOTE },
      { userId: HAS_COLLECTION, modelId: OTHER, note: null },
      { userId: NO_COLLECTION, modelId: LIVE, note: BACKFILL_NOTE },
      { userId: OTHER_USER, modelId: LIVE, note: BACKFILL_NOTE },
      { userId: OTHER_USER, modelId: OWN_PRIVATE, note: BACKFILL_NOTE },
    ]);
    const plain = await db.query(`SELECT 1 FROM "CollectionItem" WHERE "collectionId" = 2`);
    expect(plain.rows).toHaveLength(0);
  });

  it('a second run adds nothing', async () => {
    await run(options({ apply: true }), deps);
    const again = await run(options({ apply: true }), deps);
    expect(again).toEqual({ pairs: 0, users: 0, added: 0 });
    expect(await liked()).toHaveLength(5);
  });

  it('resumes from a cursor', async () => {
    const totals = await run(options({ apply: true, from: 6 }), deps);
    expect(totals.added).toBe(2);
    expect(await liked()).toEqual([
      { userId: HAS_COLLECTION, modelId: OTHER, note: null },
      { userId: NO_COLLECTION, modelId: LIVE, note: BACKFILL_NOTE },
      { userId: OTHER_USER, modelId: OWN_PRIVATE, note: BACKFILL_NOTE },
    ]);
  });
});
