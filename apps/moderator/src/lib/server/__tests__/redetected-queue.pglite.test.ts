import { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs the re-detected queue SQL on real Postgres: a predicate that compiles can still select the wrong rows. */

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

const { getRedetectedModels, getRedetectedCount } = await import('../minor-hash.service');

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published', "type" TEXT NOT NULL DEFAULT 'LORA',
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE, "meta" JSONB
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER,
  "status" TEXT NOT NULL DEFAULT 'Published', "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
  "baseModel" TEXT, "trainedWords" TEXT[]
);
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

const grant = { at: '2026-09-01T00:00:00Z', by: 5, textHash: 'old', via: 'moderator' };
const redetected = (at: string) => ({ workflowId: 'wf', reason: 'r', textHash: 'new', at });

let pg: PGlite;
beforeEach(async () => {
  pg = new PGlite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  await pg.exec(`INSERT INTO "User" VALUES (1, 'owner'), (2, 'other'), (5, 'mod')`);
});
afterEach(async () => {
  await pg.close();
});

const seedModel = (id: number, userId: number, textScanFlags: unknown) =>
  pg.query(`INSERT INTO "Model" (id, name, "userId", meta) VALUES ($1, $2, $3, $4)`, [
    id,
    `model ${id}`,
    userId,
    JSON.stringify(textScanFlags === null ? {} : { textScanFlags }),
  ]);

describe('getRedetectedModels', () => {
  beforeEach(async () => {
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
    // Owned by user 1 but with an id of its own, so a search can tell a model id from a user id.
    await seedModel(7, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-04T00:00:00Z') },
    });
    // Cleared and quiet, a plain open flag, and a model with no scan data: none are waiting.
    await seedModel(3, 1, { minor: { appealGranted: grant } });
    await seedModel(4, 1, { minor: { workflowId: 'wf', reason: 'r' } });
    await seedModel(5, 1, null);
  });

  it('lists a row per waiting label, oldest detection first', async () => {
    const { items, hasMore } = await getRedetectedModels({ limit: 10 });
    expect(items.map((r) => [r.modelId, r.label])).toEqual([
      [2, 'minor'],
      [1, 'minor'],
      [2, 'poi'],
      [7, 'minor'],
    ]);
    expect(hasMore).toBe(false);
  });

  it('carries the prior clear with the moderator who made it', async () => {
    const [row] = (await getRedetectedModels({ limit: 10 })).items;
    expect(row.granted).toMatchObject({ via: 'moderator', by: 5 });
    expect(row.grantedByUsername).toBe('mod');
    expect(row.redetected).toMatchObject({ textHash: 'new', reason: 'r' });
  });

  it('flags the models whose owner also has an open appeal', async () => {
    await pg.exec(`INSERT INTO "Appeal" VALUES
      (1, 'Model', 1, 'Pending'), (2, 'Model', 2, 'Approved')`);
    const { items } = await getRedetectedModels({ limit: 10 });
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.hasPendingAppeal]))).toEqual({
      1: true,
      2: false,
      7: false,
    });
  });

  it('pages and reports whether more remain', async () => {
    const first = await getRedetectedModels({ limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await getRedetectedModels({ limit: 2, offset: 2 });
    expect(second.items.map((r) => [r.modelId, r.label])).toEqual([
      [2, 'poi'],
      [7, 'minor'],
    ]);
    expect(second.hasMore).toBe(false);
  });

  it('searches a model id and a user id apart', async () => {
    const ids = async (search: Parameters<typeof getRedetectedModels>[0]['search']) =>
      (await getRedetectedModels({ limit: 10, search })).items.map((r) => r.modelId);

    // 7 is a model id only; 1 is a user id (owning models 1 and 7) as well as model 1's id.
    expect(await ids({ modelOrUserId: 7 })).toEqual([7]);
    expect(await ids({ modelOrUserId: 1 })).toEqual([1, 7]);
    expect(await ids({ modelOrUserId: 3 })).toEqual([]);
  });

  it('searches by username, ignoring case', async () => {
    const { items } = await getRedetectedModels({ limit: 10, search: { username: 'OTHER' } });
    expect(items.map((r) => r.modelId)).toEqual([2, 2]);
  });

  it('filters by label', async () => {
    const ids = async (flag: 'all' | 'minor' | 'poi') =>
      (await getRedetectedModels({ limit: 10, filters: { flag, sort: 'oldest' } })).items.map(
        (r) => [r.modelId, r.label]
      );
    expect(await ids('poi')).toEqual([[2, 'poi']]);
    expect(await ids('minor')).toEqual([
      [2, 'minor'],
      [1, 'minor'],
      [7, 'minor'],
    ]);
    expect((await ids('all')).length).toBe(4);
  });

  it('sorts newest detection first, and pages in that order', async () => {
    const newest = { flag: 'all', sort: 'newest' } as const;
    const { items } = await getRedetectedModels({ limit: 10, filters: newest });
    expect(items.map((r) => [r.modelId, r.label])).toEqual([
      [7, 'minor'],
      [2, 'poi'],
      [1, 'minor'],
      [2, 'minor'],
    ]);
    const second = await getRedetectedModels({ limit: 2, offset: 2, filters: newest });
    expect(second.items.map((r) => r.modelId)).toEqual([1, 2]);
  });

  it('puts a detection with no timestamp last in either order', async () => {
    await seedModel(9, 1, {
      minor: { appealGranted: grant, redetected: { workflowId: 'wf', textHash: 'n' } },
    });
    for (const sort of ['oldest', 'newest'] as const) {
      const { items } = await getRedetectedModels({ limit: 10, filters: { flag: 'all', sort } });
      expect(items.at(-1)?.modelId).toBe(9);
    }
  });

  it('carries the earlier rulings kept on the entry', async () => {
    await seedModel(10, 1, {
      minor: {
        appealGranted: grant,
        redetected: redetected('2026-10-05T00:00:00Z'),
        rulings: [
          { decision: 'appealUpheld', at: '2026-08-01T00:00:00Z', by: 5, via: 'moderator' },
        ],
      },
    });
    const { items } = await getRedetectedModels({ limit: 10, search: { modelOrUserId: 10 } });
    expect(items[0].rulings).toEqual([
      expect.objectContaining({ decision: 'appealUpheld', by: 5 }),
    ]);
    expect(
      (await getRedetectedModels({ limit: 10 })).items.find((r) => r.modelId === 1)?.rulings
    ).toBeNull();
  });

  it('loads cover images the way the appeals queue does: own posts, published first', async () => {
    await pg.exec(`
      INSERT INTO "ModelVersion" VALUES (101, 1, 0), (102, 7, 0);
      INSERT INTO "Post" VALUES
        (1, 101, 1, '2026-09-01'), (2, 101, 1, NULL), (3, 101, 99, '2026-09-01'), (4, 102, 1, NULL);
      INSERT INTO "Image" VALUES
        (11, 1, 'published.jpg', 'image', 0), (12, 2, 'draft.jpg', 'image', 0),
        (13, 3, 'someone-elses.jpg', 'image', 0), (14, 1, 'clip.mp4', 'video', 1),
        (15, 4, 'only-draft.jpg', 'image', 0);
    `);
    const { items } = await getRedetectedModels({ limit: 10 });
    const covers = (id: number) =>
      items.find((r) => r.modelId === id && r.label === 'minor')?.coverImages.map((c) => c.url);
    expect(covers(1)).toEqual(['published.jpg', 'draft.jpg']);
    expect(covers(7)).toEqual(['only-draft.jpg']);
    expect(covers(2)).toEqual([]);
  });

  it('keeps the page cut at the limit when images multiply rows', async () => {
    await pg.exec(`
      INSERT INTO "ModelVersion" VALUES (101, 2, 0);
      INSERT INTO "Post" VALUES (1, 101, 2, '2026-09-01');
      INSERT INTO "Image" VALUES (11, 1, 'a.jpg', 'image', 0), (12, 1, 'b.jpg', 'image', 1);
    `);
    const { items } = await getRedetectedModels({ limit: 2 });
    expect(items.map((r) => [r.modelId, r.label])).toEqual([
      [2, 'minor'],
      [1, 'minor'],
    ]);
  });
});

describe('getRedetectedCount', () => {
  it('counts every label waiting, ignoring search and paging', async () => {
    expect(await getRedetectedCount()).toBe(0);
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
    await seedModel(3, 1, { minor: { appealGranted: grant } });
    await seedModel(5, 1, null);
    expect(await getRedetectedCount()).toBe(3);
  });
});

describe("getRedetectedCount with the list's filters", () => {
  beforeEach(async () => {
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
  });

  it('counts under the flag filter and search, matching the list', async () => {
    expect(await getRedetectedCount({ flag: 'poi' })).toBe(1);
    expect(await getRedetectedCount({ flag: 'minor' })).toBe(2);
    expect(await getRedetectedCount({ search: { username: 'OTHER' } })).toBe(2);
    expect(await getRedetectedCount({ search: { modelOrUserId: 1 } })).toBe(1);
    const filters = { flag: 'minor', sort: 'oldest' } as const;
    const search = { username: 'owner' };
    expect(await getRedetectedCount({ flag: 'minor', search })).toBe(
      (await getRedetectedModels({ limit: 10, search, filters })).items.length
    );
  });
});

describe('model and uploader facts', () => {
  it('carries the model, tags, trigger words, uploader flags and past appeals', async () => {
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await pg.exec(`
      UPDATE "Model" SET "type" = 'Checkpoint' WHERE id = 1;
      INSERT INTO "Model" (id, name, "userId", minor) VALUES (50, 'other flagged', 1, TRUE), (51, 'clean', 1, FALSE);
      INSERT INTO "ModelVersion" (id, "modelId", "baseModel", "trainedWords")
        VALUES (101, 1, 'SDXL 1.0', ARRAY['zed', 'alpha']);
      INSERT INTO "Tag" VALUES (1, 'style'), (2, 'anime');
      INSERT INTO "TagsOnModels" VALUES (1, 1), (1, 2);
      INSERT INTO "Appeal" (id, "entityType", "entityId", "status", "userId")
        VALUES (20, 'Model', 50, 'Approved', 1), (21, 'Model', 51, 'Rejected', 1), (22, 'Model', 1, 'Pending', 1);
    `);
    const [row] = (await getRedetectedModels({ limit: 10 })).items;
    expect(row).toMatchObject({
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
      trainedWords: ['zed', 'alpha'],
      tags: ['anime', 'style'],
      tagCount: 2,
      otherFlaggedModels: 1,
      pastAppeals: { approved: 1, rejected: 1, void: 0, pending: 1 },
    });
  });
});
