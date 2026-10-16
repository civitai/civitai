import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs the File matches query on real Postgres: who counts as a match, and the facts each row carries. */

const { dbHandle } = vi.hoisted(() => ({ dbHandle: { current: null as unknown } }));

vi.mock('../db', () => ({
  get dbRead() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
  get dbWrite() {
    if (!dbHandle.current) throw new Error('the pglite client was not installed for this test');
    return dbHandle.current;
  },
}));
vi.mock('../cache', () => ({ createCache: () => ({ get: vi.fn(), bust: vi.fn() }) }));

const { getMinorHashMatchesForReview } = await import('../minor-hash.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published', "type" TEXT NOT NULL DEFAULT 'LORA',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE, "meta" JSONB,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "baseModel" TEXT, "trainedWords" TEXT[]
);
CREATE TABLE "ModelFile" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE "ModelFileHash" ("fileId" INTEGER NOT NULL, "type" TEXT NOT NULL, "hash" TEXT NOT NULL);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TagsOnModels" ("modelId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER, "userId" INTEGER NOT NULL, "publishedAt" TIMESTAMP
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER, "url" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'image',
  "index" INTEGER
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending', "userId" INTEGER
);
`;

let pg: PGlite;
let nextId = 1;
beforeEach(async () => {
  nextId = 1;
  pg = new PGlite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  await pg.exec(`INSERT INTO "User" VALUES (1, 'seeder'), (2, 'copier'), (3, 'third')`);
});
afterEach(async () => {
  await pg.close();
});

/** A model with one version and one SHA256-hashed file. */
const seedModel = async (
  id: number,
  userId: number,
  hash: string,
  { minor = false, meta = {} }: { minor?: boolean; meta?: object } = {}
) => {
  await pg.query(
    `INSERT INTO "Model" (id, name, "userId", minor, meta, "lockedProperties")
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, `model ${id}`, userId, minor, JSON.stringify(meta), minor ? ['minor'] : []]
  );
  const versionId = nextId++;
  const fileId = nextId++;
  await pg.query(
    `INSERT INTO "ModelVersion" (id, "modelId", "baseModel", "trainedWords") VALUES ($1, $2, 'SDXL 1.0', $3)`,
    [versionId, id, ['chibi', 'cute']]
  );
  await pg.query(`INSERT INTO "ModelFile" (id, "modelVersionId", type) VALUES ($1, $2, 'Model')`, [
    fileId,
    versionId,
  ]);
  await pg.query(`INSERT INTO "ModelFileHash" ("fileId", type, hash) VALUES ($1, 'SHA256', $2)`, [
    fileId,
    hash,
  ]);
};

describe('getMinorHashMatchesForReview', () => {
  beforeEach(async () => {
    await seedModel(10, 1, 'aa', { minor: true });
    await seedModel(11, 2, 'aa'); // a different uploader sharing the file: a match
    await seedModel(12, 1, 'aa'); // the seed's own uploader: auto-flagged elsewhere, not a match
    await seedModel(13, 3, 'bb'); // shares nothing with a flagged model
    await seedModel(14, 3, 'aa', { meta: { minorHashDismissed: true } }); // already dismissed
  });

  it('lists only unflagged, undismissed copies by a different uploader', async () => {
    const { items } = await getMinorHashMatchesForReview({ limit: 10 });
    expect(items.map((r) => [r.modelId, r.minorModelId])).toEqual([[11, 10]]);
  });

  it('carries the facts, covers and uploader context the detail shows', async () => {
    await pg.query(`INSERT INTO "Tag" VALUES (1, 'style')`);
    await pg.query(`INSERT INTO "TagsOnModels" VALUES (11, 1)`);
    const { rows } = await pg.query<{ id: number }>(
      `SELECT id FROM "ModelVersion" WHERE "modelId" = 11`
    );
    await pg.query(`INSERT INTO "Post" VALUES (1, $1, 2, now())`, [rows[0].id]);
    await pg.query(`INSERT INTO "Image" VALUES (1, 1, 'cover-url', 'image', 0)`);
    await pg.query(
      `INSERT INTO "Model" (id, name, "userId", minor) VALUES (30, 'other flagged', 2, true)`
    );

    const [row] = (await getMinorHashMatchesForReview({ limit: 10 })).items;
    expect(row).toMatchObject({
      modelType: 'LORA',
      baseModel: 'SDXL 1.0',
      trainedWords: ['chibi', 'cute'],
      trainedWordCount: 2,
      tags: ['style'],
      tagCount: 1,
      otherFlaggedModels: 1,
      pastAppeals: { approved: 0, rejected: 0, void: 0, pending: 0 },
    });
    expect(row.coverImages).toEqual([{ id: 1, url: 'cover-url' }]);
  });

  it('pages with one extra row to know there is another page', async () => {
    await seedModel(15, 3, 'aa');
    const first = await getMinorHashMatchesForReview({ limit: 1 });
    expect(first.items.map((r) => r.modelId)).toEqual([11]);
    expect(first.hasMore).toBe(true);
    const second = await getMinorHashMatchesForReview({ limit: 1, offset: 1 });
    expect(second.items.map((r) => r.modelId)).toEqual([15]);
    expect(second.hasMore).toBe(false);
  });
});
