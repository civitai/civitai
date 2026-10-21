import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs Needs review's file-match half on real Postgres: who counts as a match, the facts each row
 *  carries, and how matches and held detections share one list. */

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
vi.mock('../cache', () => ({
  createCache: ({ fetch }: { fetch: () => Promise<unknown> }) => ({
    get: () => fetch(),
    bust: vi.fn(),
  }),
}));

const { getAutoFlaggedMinorMatch, getMinorQueueCounts, getNeedsReviewCount, getNeedsReviewModels } =
  await import('../minor-hash.service');

const MATCHES = { detections: false, matches: true };
const BOTH = { detections: true, matches: true };
/** The File matches half of Needs review, as a viewer holding only that permission sees it. */
const matches = (query: { limit: number; offset?: number; search?: { text: string } }) =>
  getNeedsReviewModels({ ...query, sources: MATCHES });

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published', "type" TEXT NOT NULL DEFAULT 'LORA',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE, "meta" JSONB,
  "deletedAt" TIMESTAMP, "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "baseModel" TEXT, "trainedWords" TEXT[]
);
CREATE TABLE "ModelFile" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "name" TEXT NOT NULL DEFAULT 'file',
  "sizeKB" DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE "ModelFileHash" ("fileId" INTEGER NOT NULL, "type" TEXT NOT NULL, "hash" TEXT NOT NULL);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TagsOnModels" ("modelId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER, "userId" INTEGER NOT NULL, "publishedAt" TIMESTAMP
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "postId" INTEGER, "url" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'image',
  "index" INTEGER, "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "minor" BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "activity" TEXT NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now()
);
CREATE TABLE "EntityModeration" (
  "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Succeeded',
  "result" JSONB, "updatedAt" TIMESTAMP NOT NULL DEFAULT now(), "workflowId" TEXT
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending', "userId" INTEGER, "category" TEXT
);
`;

let pg: PGlite;
let nextId = 1;
beforeEach(async () => {
  nextId = 1;
  pg = await freshPglite();
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
  await pg.query(
    `INSERT INTO "ModelFile" (id, "modelVersionId", type, name, "sizeKB") VALUES ($1, $2, 'Model', $3, 1024)`,
    [fileId, versionId, `file-${id}.safetensors`]
  );
  await pg.query(`INSERT INTO "ModelFileHash" ("fileId", type, hash) VALUES ($1, 'SHA256', $2)`, [
    fileId,
    hash,
  ]);
};

describe('Needs review: file matches', () => {
  beforeEach(async () => {
    await seedModel(10, 1, 'aa', { minor: true });
    await seedModel(11, 2, 'aa'); // a different uploader sharing the file: a match
    await seedModel(12, 1, 'aa'); // the seed's own uploader: auto-flagged elsewhere, not a match
    await seedModel(13, 3, 'bb'); // shares nothing with a flagged model
    await seedModel(14, 3, 'aa', { meta: { minorHashDismissed: true } }); // already dismissed
  });

  it('lists only unflagged, undismissed copies by a different uploader', async () => {
    const { items } = await matches({ limit: 10 });
    expect(items.map((r) => [r.modelId, r.match?.minorModelId])).toEqual([[11, 10]]);
    expect(items[0].flags).toEqual([]);
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

    const [row] = (await matches({ limit: 10 })).items;
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
    expect(row.coverImages).toEqual([
      {
        id: 1,
        url: 'cover-url',
        nsfwLevel: 1,
        type: 'image',
        minor: false,
        acceptableMinor: false,
      },
    ]);
    // The shared file as this model stores it: its own name for the bytes the seed also carries.
    expect(row.match).toMatchObject({
      fileName: 'file-11.safetensors',
      fileSizeKB: 1024,
      hash: 'aa',
      minorModelName: 'model 10',
      minorUserId: 1,
    });
    expect(row.match?.minorModelVersionId).toEqual(expect.any(Number));
    expect(row.match?.modelVersionId).toEqual(expect.any(Number));
  });

  it('searches a model name as a case-insensitive substring, wildcards taken literally', async () => {
    await seedModel(15, 3, 'aa');
    await pg.query(`UPDATE "Model" SET name = 'Cute 100%_Chibi' WHERE id = 15`);
    const ids = async (text: string) =>
      (await matches({ limit: 10, search: { text } })).items.map((r) => r.modelId);

    expect(await ids('chibi')).toEqual([15]);
    expect(await ids('%')).toEqual([15]);
    // Unescaped, `_` would match the space in "model 11".
    expect(await ids('l_1')).toEqual([]);
    // The uploader's name still matches whole.
    expect(await ids('COPIER')).toEqual([11]);
  });

  it('pages with one extra row to know there is another page', async () => {
    await seedModel(15, 3, 'aa');
    const first = await matches({ limit: 1 });
    expect(first.items.map((r) => r.modelId)).toEqual([11]);
    expect(first.hasMore).toBe(true);
    const second = await matches({ limit: 1, offset: 1 });
    expect(second.items.map((r) => r.modelId)).toEqual([15]);
    expect(second.hasMore).toBe(false);
  });
});

describe('getAutoFlaggedMinorMatch', () => {
  it("names this model's copy of the shared file, with its size", async () => {
    await seedModel(10, 1, 'aa', { minor: true });
    await seedModel(12, 1, 'aa');
    expect(await getAutoFlaggedMinorMatch({ modelId: 12 })).toMatchObject({
      minorModelId: 10,
      hash: 'aa',
      fileName: 'file-12.safetensors',
      fileSizeKB: 1024,
    });
  });
});

describe('Needs review: held detections and file matches in one list', () => {
  const held = (at: string) => ({
    textScanFlags: {
      minor: { redetected: { workflowId: 'wf', textHash: 'n', kind: 'first', at } },
    },
  });

  beforeEach(async () => {
    await seedModel(10, 1, 'aa', { minor: true });
    // File matches, their shared files uploaded on these days.
    await seedModel(11, 2, 'aa');
    await seedModel(15, 3, 'aa');
    await pg.query(
      `UPDATE "ModelFile" SET "createdAt" = '2026-10-05' WHERE name = 'file-11.safetensors'`
    );
    await pg.query(
      `UPDATE "ModelFile" SET "createdAt" = '2026-10-01' WHERE name = 'file-15.safetensors'`
    );
    // A held detection on its own, and one on a model that is also a file match.
    await seedModel(20, 3, 'zz', { meta: held('2026-10-03T00:00:00Z') });
    await pg.query(`UPDATE "Model" SET meta = $1::jsonb WHERE id = 11`, [
      JSON.stringify(held('2026-10-08T00:00:00Z')),
    ]);
  });

  const rows = async (sources = BOTH, extra: object = {}) =>
    (await getNeedsReviewModels({ limit: 10, sources, ...extra })).items.map((r) => [
      r.modelId,
      r.flags.map((f) => f.source),
      r.match ? 'match' : null,
    ]);

  it('lists one row per model, oldest lead first: a detection by when it was held, a match by its file upload', async () => {
    expect(await rows()).toEqual([
      [15, [], 'match'],
      [20, ['redetected'], null],
      // Model 11 carries both; its oldest lead (the file, 10-05) places it.
      [11, ['redetected'], 'match'],
    ]);
  });

  it('lists only the kinds of lead the viewer may rule', async () => {
    expect(await rows({ detections: true, matches: false })).toEqual([
      [20, ['redetected'], null],
      [11, ['redetected'], null],
    ]);
    expect(await rows(MATCHES)).toEqual([
      [15, [], 'match'],
      [11, [], 'match'],
    ]);
    expect(await rows({ detections: false, matches: false })).toEqual([]);
  });

  it('narrows by source chip, and drops file matches under a real-person filter', async () => {
    const hash = { filters: { source: 'hash', flag: 'all', sort: 'oldest' } };
    expect((await rows(BOTH, hash)).map((r) => r[0])).toEqual([15, 11]);
    const textScan = { filters: { source: 'text-scan', flag: 'all', sort: 'oldest' } };
    expect((await rows(BOTH, textScan)).map((r) => r[0])).toEqual([20, 11]);
    const poi = { filters: { source: 'all', flag: 'poi', sort: 'oldest' } };
    expect(await rows(BOTH, poi)).toEqual([]);
  });

  it('sorts newest first on each model’s newest lead', async () => {
    const newest = { filters: { source: 'all', flag: 'all', sort: 'newest' } };
    expect((await rows(BOTH, newest)).map((r) => r[0])).toEqual([11, 20, 15]);
  });

  it('counts models, a model with both kinds once, the same as the list', async () => {
    expect(await getNeedsReviewCount({ sources: BOTH })).toBe(3);
    expect(await getNeedsReviewCount({ sources: MATCHES })).toBe(2);
    expect(await getMinorQueueCounts()).toEqual({ pending: 2, pendingWithDetection: 1 });
  });
});
