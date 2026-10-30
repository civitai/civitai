import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';

/** Runs the Flagged queue SQL (hash auto-flags, text-scan auto-flags and re-detections) on real Postgres: a predicate that compiles can still select the wrong rows. */

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

const {
  getAutoFlaggedCount,
  getFlaggedCount,
  getFlaggedModels,
  getFlaggedSourceCounts,
  getHeldDetectionModelCount,
  getModelAppealState,
  getNeedsReviewCount,
  getNeedsReviewModels,
  reviewDaysLeft,
} = await import('../minor-hash.service');

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

const grant = { at: '2026-09-01T00:00:00Z', by: 5, textHash: 'old', via: 'moderator' };
const redetected = (at: string) => ({ workflowId: 'wf', reason: 'r', textHash: 'new', at });

let pg: PGlite;
beforeEach(async () => {
  pg = await freshPglite();
  dbHandle.current = new Kysely({ dialect: pgliteDialect(pg) });
  await pg.exec(SCHEMA);
  await pg.exec(`INSERT INTO "User" VALUES (1, 'owner'), (2, 'other'), (5, 'mod')`);
});
afterEach(async () => {
  await pg.close();
});

type Items = Awaited<ReturnType<typeof getFlaggedModels | typeof getNeedsReviewModels>>['items'];

/** Needs review with held detections only: these tests seed no files, so no file matches. */
const DETECTIONS = { detections: true, matches: false };
const needsReview = (query: Omit<Parameters<typeof getNeedsReviewModels>[0], 'sources'>) =>
  getNeedsReviewModels({ ...query, sources: DETECTIONS });
const needsReviewCount = (query: Omit<Parameters<typeof getNeedsReviewCount>[0], 'sources'>) =>
  getNeedsReviewCount({ ...query, sources: DETECTIONS });
/** Each row's flags in order, as model:label:source. */
const flagKeys = (items: Items) =>
  items.flatMap((r) => r.flags.map((f) => `${r.modelId}:${f.label}:${f.source}`));
const rowLabels = (items: Items) => items.map((r) => [r.modelId, r.flags.map((f) => f.label)]);

const seedModel = (id: number, userId: number, textScanFlags: unknown) =>
  pg.query(`INSERT INTO "Model" (id, name, "userId", meta) VALUES ($1, $2, $3, $4)`, [
    id,
    `model ${id}`,
    userId,
    JSON.stringify(textScanFlags === null ? {} : { textScanFlags }),
  ]);

describe('Needs review: held detections', () => {
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

  it('lists a row per model carrying its waiting labels, oldest detection first', async () => {
    const { items, hasMore } = await needsReview({ limit: 10 });
    expect(rowLabels(items)).toEqual([
      [2, ['minor', 'poi']],
      [1, ['minor']],
      [7, ['minor']],
    ]);
    expect(items.map((r) => r.key)).toEqual(['2', '1', '7']);
    expect(hasMore).toBe(false);
  });

  it('carries the prior clear with the moderator who made it', async () => {
    const [flag] = (await needsReview({ limit: 10 })).items[0].flags;
    expect(flag.granted).toMatchObject({ via: 'moderator', by: 5 });
    expect(flag.grantedByUsername).toBe('mod');
    expect(flag.redetected).toMatchObject({ textHash: 'new', reason: 'r' });
  });

  it('flags the models whose owner also has an open appeal', async () => {
    await pg.exec(`INSERT INTO "Appeal" VALUES
      (1, 'Model', 1, 'Pending'), (2, 'Model', 2, 'Approved')`);
    const { items } = await needsReview({ limit: 10 });
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.hasPendingAppeal]))).toEqual({
      1: true,
      2: false,
      7: false,
    });
  });

  it('ignores a site-form appeal, which is about an unpublish rather than the flag', async () => {
    await pg.exec(`INSERT INTO "Appeal" (id, "entityType", "entityId", "status", "userId", "category")
      VALUES (1, 'Model', 1, 'Pending', 1, 'Model')`);
    const { items } = await needsReview({ limit: 10 });
    expect(items.find((r) => r.modelId === 1)?.hasPendingAppeal).toBe(false);
  });

  it('pages by model and reports whether more remain', async () => {
    const first = await needsReview({ limit: 2 });
    expect(first.items.map((r) => r.modelId)).toEqual([2, 1]);
    expect(first.hasMore).toBe(true);
    const second = await needsReview({ limit: 2, offset: 2 });
    expect(second.items.map((r) => r.modelId)).toEqual([7]);
    expect(second.hasMore).toBe(false);
  });

  it('searches a model id and a user id apart', async () => {
    const ids = async (search: Parameters<typeof needsReview>[0]['search']) =>
      (await needsReview({ limit: 10, search })).items.map((r) => r.modelId);

    // 7 is a model id only; 1 is a user id (owning models 1 and 7) as well as model 1's id.
    expect(await ids({ modelOrUserId: 7 })).toEqual([7]);
    expect(await ids({ modelOrUserId: 1 })).toEqual([1, 7]);
    expect(await ids({ modelOrUserId: 3 })).toEqual([]);
  });

  it('searches by username, ignoring case', async () => {
    const { items } = await needsReview({ limit: 10, search: { text: 'OTHER' } });
    expect(rowLabels(items)).toEqual([[2, ['minor', 'poi']]]);
  });

  it('searches a model name as a case-insensitive substring, wildcards taken literally', async () => {
    await pg.query(`UPDATE "Model" SET name = 'Pony 50%_off' WHERE id = 2`);
    const ids = async (text: string) =>
      (await needsReview({ limit: 10, search: { text } })).items.map((r) => r.modelId);

    expect(await ids('pONY')).toEqual([2]);
    expect(await ids('%')).toEqual([2]);
    // Unescaped, `_` would match the space in "model 1".
    expect(await ids('l_1')).toEqual([]);
    expect(await needsReviewCount({ search: { text: 'pony' } })).toBe(1);
  });

  it('filters by label', async () => {
    const ids = async (flag: 'all' | 'minor' | 'poi') =>
      (await needsReview({ limit: 10, filters: { source: 'all', flag, sort: 'oldest' } })).items;
    // A filter narrows the flags a row carries, not only which rows show.
    expect(rowLabels(await ids('poi'))).toEqual([[2, ['poi']]]);
    expect(rowLabels(await ids('minor'))).toEqual([
      [2, ['minor']],
      [1, ['minor']],
      [7, ['minor']],
    ]);
    expect((await ids('all')).length).toBe(3);
  });

  it("sorts newest first on each model's newest detection, and pages in that order", async () => {
    const newest = { source: 'all', flag: 'all', sort: 'newest' } as const;
    const { items } = await needsReview({ limit: 10, filters: newest });
    expect(items.map((r) => r.modelId)).toEqual([7, 2, 1]);
    const second = await needsReview({ limit: 2, offset: 2, filters: newest });
    expect(second.items.map((r) => r.modelId)).toEqual([1]);
  });

  it('puts a detection with no timestamp last in either order', async () => {
    await seedModel(9, 1, {
      minor: { appealGranted: grant, redetected: { workflowId: 'wf', textHash: 'n' } },
    });
    for (const sort of ['oldest', 'newest'] as const) {
      const { items } = await needsReview({
        limit: 10,
        filters: { source: 'all', flag: 'all', sort },
      });
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
    const { items } = await needsReview({ limit: 10, search: { modelOrUserId: 10 } });
    expect(items[0].flags[0].rulings).toEqual([
      expect.objectContaining({ decision: 'appealUpheld', by: 5 }),
    ]);
    expect(
      (await needsReview({ limit: 10 })).items.find((r) => r.modelId === 1)?.flags[0].rulings
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
    const { items } = await needsReview({ limit: 10 });
    const covers = (id: number) =>
      items.find((r) => r.modelId === id)?.coverImages.map((c) => c.url);
    expect(covers(1)).toEqual(['published.jpg', 'clip.mp4', 'draft.jpg']);
    expect(covers(7)).toEqual(['only-draft.jpg']);
    expect(covers(2)).toEqual([]);
    expect(items.find((r) => r.modelId === 1)?.coverImages[0]).toEqual({
      id: 11,
      url: 'published.jpg',
      nsfwLevel: 1,
      type: 'image',
      minor: false,
      acceptableMinor: false,
    });
  });

  it('keeps the page cut at the limit when images multiply rows', async () => {
    await pg.exec(`
      INSERT INTO "ModelVersion" VALUES (101, 2, 0);
      INSERT INTO "Post" VALUES (1, 101, 2, '2026-09-01');
      INSERT INTO "Image" VALUES (11, 1, 'a.jpg', 'image', 0), (12, 1, 'b.jpg', 'image', 1);
    `);
    const { items } = await needsReview({ limit: 2 });
    expect(items.map((r) => r.modelId)).toEqual([2, 1]);
  });
});

describe('getHeldDetectionModelCount', () => {
  it('counts models with a held detection, ignoring search and paging', async () => {
    expect(await getHeldDetectionModelCount()).toBe(0);
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
    await seedModel(3, 1, { minor: { appealGranted: grant } });
    await seedModel(5, 1, null);
    // Models, not labels: 2 carries two held labels.
    expect(await getHeldDetectionModelCount()).toBe(2);
  });
});

describe("the Needs review count under the list's filters", () => {
  beforeEach(async () => {
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-02T00:00:00Z') },
    });
    await seedModel(2, 2, {
      minor: { appealGranted: grant, redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { appealGranted: grant, redetected: redetected('2026-10-03T00:00:00Z') },
    });
  });

  it('counts models under the flag filter and search, matching the list', async () => {
    const count = (
      flag: 'all' | 'minor' | 'poi',
      search?: { text: string } | { modelOrUserId: number }
    ) => needsReviewCount({ search, filters: { source: 'all', flag, sort: 'oldest' } });
    expect(await count('poi')).toBe(1);
    expect(await count('minor')).toBe(2);
    expect(await count('all', { text: 'OTHER' })).toBe(1);
    expect(await count('all', { modelOrUserId: 1 })).toBe(1);
    const filters = { source: 'all', flag: 'minor', sort: 'oldest' } as const;
    const search = { text: 'owner' };
    expect(await count('minor', search)).toBe(
      (await needsReview({ limit: 10, search, filters })).items.length
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
    const [row] = (await needsReview({ limit: 10 })).items;
    expect(row).toMatchObject({
      modelType: 'Checkpoint',
      baseModel: 'SDXL 1.0',
      trainedWords: ['zed', 'alpha'],
      tags: ['anime', 'style'],
      tagCount: 2,
      otherFlaggedModels: 1,
      pastAppeals: { approved: 1, rejected: 1, void: 0, pending: 1 },
      // Nothing else shares this model's files, whatever its own appeals say.
      sameFileAppeals: { approved: 0, rejected: 0, void: 0, pending: 0, models: 0 },
    });
  });
});

describe('Auto-flagged: hash auto-flags', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const snapshot = (source: string, at: string, extra: object = {}) => ({
    minorFlagSnapshot: { source, at, prevNsfw: true, prevGalleryLevel: 4 },
    ...extra,
  });
  const seedFlagged = (id: number, userId: number, meta: unknown, minor = true) =>
    pg.query(`INSERT INTO "Model" (id, name, "userId", minor, meta) VALUES ($1, $2, $3, $4, $5)`, [
      id,
      `model ${id}`,
      userId,
      minor,
      JSON.stringify(meta),
    ]);
  const keys = async (filters: Partial<Parameters<typeof getFlaggedModels>[0]>) =>
    flagKeys((await getFlaggedModels({ limit: 20, ...filters })).items);

  beforeEach(async () => {
    await seedFlagged(20, 1, snapshot('auto', daysAgo(25)));
    await seedFlagged(21, 2, snapshot('auto', daysAgo(2)));
    // Out of the queue: past the 30-day window, accepted, a moderator's own flag, and one a
    // moderator affirmed by hand after the scan hook flagged it.
    await seedFlagged(22, 1, snapshot('auto', daysAgo(31)));
    await seedFlagged(
      23,
      1,
      snapshot('auto', daysAgo(3), { minorHashAccepted: { at: daysAgo(1) } })
    );
    await seedFlagged(24, 1, snapshot('manual', daysAgo(3)));
    await seedFlagged(25, 1, snapshot('auto', daysAgo(5)));
    await pg.query(
      `INSERT INTO "ModActivity" ("entityType", "entityId", activity, "createdAt")
       VALUES ('model', 25, 'setMinor', $1)`,
      [daysAgo(1)]
    );
    await seedModel(1, 1, {
      minor: { appealGranted: grant, redetected: redetected(daysAgo(10)) },
    });
  });

  it('lists hash flags oldest first, and leaves held detections to Needs review', async () => {
    expect(await keys({})).toEqual(['20:minor:hash', '21:minor:hash']);
  });

  it('says which models Needs review also lists', async () => {
    await pg.query(`UPDATE "Model" SET meta = meta || $1::jsonb WHERE id = 20`, [
      JSON.stringify({ textScanFlags: { poi: { redetected: redetected(daysAgo(1)) } } }),
    ]);
    const { items } = await getFlaggedModels({ limit: 20 });
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.alsoInNeedsReview]))).toEqual({
      20: true,
      21: false,
    });
  });

  it('keeps only auto-flags inside the review window that nobody has affirmed', async () => {
    const hash = await keys({ filters: { source: 'hash', flag: 'all', sort: 'oldest' } });
    expect(hash).toEqual(['20:minor:hash', '21:minor:hash']);
  });

  it('puts days left on hash flags only', async () => {
    const { items } = await getFlaggedModels({ limit: 20 });
    const flags = items.flatMap((r) =>
      r.flags.map((f) => [`${r.modelId}:${f.source}`, f] as const)
    );
    expect(Object.fromEntries(flags.map(([k, f]) => [k, f.daysLeft]))).toEqual({
      '20:hash': 5,
      '21:hash': 28,
    });
    const byKey = Object.fromEntries(flags);
    expect(byKey['20:hash']).toMatchObject({
      prevNsfw: true,
      prevGalleryLevel: 4,
      redetected: null,
      textHash: null,
    });
  });

  it('filters by source and by flag', async () => {
    const f = (source: 'all' | 'hash' | 'text-scan', flag: 'all' | 'minor' | 'poi') =>
      keys({ filters: { source, flag, sort: 'oldest' } });
    expect(await f('text-scan', 'all')).toEqual([]);
    // Hash flags are minor flags: a real-person filter leaves none of them.
    expect(await f('hash', 'poi')).toEqual([]);
    expect(await f('all', 'poi')).toEqual([]);
    expect(await f('all', 'minor')).toEqual(['20:minor:hash', '21:minor:hash']);
  });

  it('sorts newest first', async () => {
    expect(await keys({ filters: { source: 'all', flag: 'all', sort: 'newest' } })).toEqual([
      '21:minor:hash',
      '20:minor:hash',
    ]);
  });

  it('pages and reports whether more remain', async () => {
    const first = await getFlaggedModels({ limit: 1 });
    expect(flagKeys(first.items)).toEqual(['20:minor:hash']);
    expect(first.hasMore).toBe(true);
    const second = await getFlaggedModels({ limit: 1, offset: 1 });
    expect(flagKeys(second.items)).toEqual(['21:minor:hash']);
    expect(second.hasMore).toBe(false);
  });

  it('searches by model id, user id and username', async () => {
    expect(await keys({ search: { modelOrUserId: 1 } })).toEqual(['20:minor:hash']);
    expect(await keys({ search: { modelOrUserId: 21 } })).toEqual(['21:minor:hash']);
    expect(await keys({ search: { text: 'OTHER' } })).toEqual(['21:minor:hash']);
  });

  it('finds an aged-out hash flag only when searched by its model id', async () => {
    expect(await keys({})).not.toContain('22:minor:hash');
    expect(await keys({ search: { modelOrUserId: 22 } })).toEqual(['22:minor:hash']);
    // The uploader's id is not the model's: the window still applies to their other flags.
    expect(await keys({ search: { modelOrUserId: 1 } })).not.toContain('22:minor:hash');
    expect(await keys({ search: { text: 'owner' } })).not.toContain('22:minor:hash');
    expect(await getFlaggedCount({ search: { modelOrUserId: 22 } })).toBe(1);
    expect(await getAutoFlaggedCount({ search: { modelOrUserId: 22 } })).toBe(1);

    const [row] = (await getFlaggedModels({ limit: 20, search: { modelOrUserId: 22 } })).items;
    expect(row.flags[0].daysLeft).toBe(0);
  });

  it('still hides an aged-out flag a moderator accepted when searched by model id', async () => {
    await seedFlagged(
      26,
      1,
      snapshot('auto', daysAgo(40), { minorHashAccepted: { at: daysAgo(1) } })
    );
    expect(await keys({ search: { modelOrUserId: 26 } })).toEqual([]);
  });

  it('flags a hash row whose owner also has an open appeal', async () => {
    await pg.exec(
      `INSERT INTO "Appeal" VALUES (1, 'Model', 20, 'Pending'), (2, 'Model', 21, 'Void')`
    );
    const { items } = await getFlaggedModels({ limit: 20 });
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.hasPendingAppeal]))).toEqual({
      20: true,
      21: false,
    });
  });

  it('reads the appeal state the Auto-flagged ruling routes on, ignoring site-form appeals', async () => {
    await pg.exec(`INSERT INTO "Appeal" (id, "entityType", "entityId", "status", "userId", "category")
      VALUES (1, 'Model', 20, 'Pending', 1, NULL), (2, 'Model', 21, 'Pending', 1, 'Model')`);
    expect(await getModelAppealState(20)).toMatchObject({ pendingAppeal: true, minor: true });
    expect(await getModelAppealState(21)).toMatchObject({ pendingAppeal: false });
  });

  it('counts poi as flagged only with an open text-scan poi flag, as the appeal resolver does', async () => {
    await seedModel(40, 1, {});
    await seedModel(41, 1, { poi: { workflowId: 'wf', textHash: 'a' } });
    await seedModel(42, 1, { poi: { workflowId: 'wf', textHash: 'a', appealGranted: grant } });
    await pg.exec(`UPDATE "Model" SET minor = TRUE, poi = TRUE WHERE id IN (40, 41, 42)`);
    expect(await getModelAppealState(40)).toMatchObject({ minor: true, poi: false });
    expect(await getModelAppealState(41)).toMatchObject({ minor: true, poi: true });
    expect(await getModelAppealState(42)).toMatchObject({ minor: true, poi: false });
  });

  it('reads the text each text-scan flag is bound to, and any newer held text', async () => {
    await seedModel(43, 1, {
      minor: { workflowId: 'wf', textHash: 'a', redetected: redetected('2026-10-01T00:00:00Z') },
      poi: { workflowId: 'wf', textHash: 'a' },
    });
    expect((await getModelAppealState(43)).textScan).toEqual({
      minor: { textHash: 'a', redetectedTextHash: 'new' },
      poi: { textHash: 'a', redetectedTextHash: null },
    });
  });

  it('carries the rulings kept on the minor entry and the model facts for a hash row', async () => {
    await pg.exec(`
      UPDATE "Model" SET meta = meta || '{"textScanFlags":{"minor":{"rulings":[{"decision":"appealUpheld","by":5}]}}}'
        WHERE id = 20;
      INSERT INTO "ModelVersion" (id, "modelId", "baseModel") VALUES (201, 20, 'SDXL 1.0');
    `);
    const row = (await getFlaggedModels({ limit: 20 })).items.find((r) => r.modelId === 20);
    expect(row?.flags[0].rulings).toEqual([
      expect.objectContaining({ decision: 'appealUpheld', by: 5 }),
    ]);
    expect(row?.baseModel).toBe('SDXL 1.0');
  });

  it('counts the same population the list shows', async () => {
    expect(await getAutoFlaggedCount()).toBe(2);
    expect(await getFlaggedCount()).toBe(2);
    expect(await getFlaggedCount({ source: 'hash' })).toBe(2);
    expect(await getFlaggedCount({ source: 'text-scan' })).toBe(0);
    expect(await getFlaggedCount({ flag: 'poi' })).toBe(0);
    expect(await getFlaggedCount({ search: { modelOrUserId: 1 } })).toBe(1);
    expect(await getFlaggedCount({ search: { text: 'other' } })).toBe(1);
  });
});

describe('Auto-flagged: real-person hash flags', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const poiSnapshot = (source: string, at: string, extra: object = {}) => ({
    poiFlagSnapshot: { source, at, prevNsfw: false, prevGalleryLevel: 2, ...extra },
  });
  const seed = (id: number, meta: object, { poi = true, minor = false } = {}) =>
    pg.query(
      `INSERT INTO "Model" (id, name, "userId", poi, minor, meta) VALUES ($1, $2, 1, $3, $4, $5)`,
      [id, `model ${id}`, poi, minor, JSON.stringify(meta)]
    );
  const keys = async (filters?: Parameters<typeof getFlaggedModels>[0]['filters']) =>
    flagKeys((await getFlaggedModels({ limit: 20, filters })).items);

  beforeEach(async () => {
    await seed(30, poiSnapshot('auto', daysAgo(3)));
    // Out of the queue: confirmed, set by hand since, and lifted.
    await seed(32, poiSnapshot('manual', daysAgo(3), { confirmedFrom: 'auto' }));
    await seed(33, poiSnapshot('auto', daysAgo(5)));
    await pg.query(
      `INSERT INTO "ModActivity" ("entityType", "entityId", activity, "createdAt")
       VALUES ('model', 33, 'setPoi', $1)`,
      [daysAgo(1)]
    );
    await seed(34, poiSnapshot('auto', daysAgo(3)), { poi: false });
  });

  it('lists the hash flag the main app applied, under the real-person label', async () => {
    expect(await keys()).toEqual(['30:poi:hash']);
    const [row] = (await getFlaggedModels({ limit: 20 })).items;
    expect(row.flags[0]).toMatchObject({ daysLeft: null, prevNsfw: false, prevGalleryLevel: 2 });
  });

  it('follows the label filter: real person keeps it, minor drops it', async () => {
    expect(await keys({ source: 'hash', flag: 'poi', sort: 'oldest' })).toEqual(['30:poi:hash']);
    expect(await keys({ source: 'all', flag: 'minor', sort: 'oldest' })).toEqual([]);
    expect(await keys({ source: 'text-scan', flag: 'all', sort: 'oldest' })).toEqual([]);
  });

  it('a minor setMinor does not count as signing off the real-person flag', async () => {
    await pg.query(
      `INSERT INTO "ModActivity" ("entityType", "entityId", activity, "createdAt")
       VALUES ('model', 30, 'setMinor', $1)`,
      [daysAgo(1)]
    );
    expect(await keys()).toEqual(['30:poi:hash']);
  });

  it('carries both labels on one row when both were hash-flagged', async () => {
    await seed(
      35,
      {
        ...poiSnapshot('auto', daysAgo(2)),
        minorFlagSnapshot: { source: 'auto', at: daysAgo(4) },
      },
      { minor: true }
    );
    // Oldest flag first: 35's minor flag (4 d) is older than 30's.
    expect(await keys()).toEqual(['35:minor:hash', '35:poi:hash', '30:poi:hash']);
    expect(await getFlaggedCount()).toBe(2);
    expect(await getFlaggedSourceCounts()).toEqual({ all: 2, hash: 2, 'text-scan': 0 });
  });

  it('says Needs review also lists a hash-flagged model with a queued real-person match', async () => {
    // Minor hash-flagged and not poi, so a real-person match on it waits in Needs review.
    await seed(37, { minorFlagSnapshot: { source: 'auto', at: daysAgo(2) } }, { poi: false });
    const also = async () =>
      Object.fromEntries(
        (await getFlaggedModels({ limit: 20 })).items.map((r) => [r.modelId, r.alsoInNeedsReview])
      );
    expect(await also()).toEqual({ 30: false, 37: false });
    await pg.query(`UPDATE "Model" SET meta = meta || $1::jsonb WHERE id = 37`, [
      JSON.stringify({ poiHashMatch: { at: daysAgo(1), hash: 'X' } }),
    ]);
    expect(await also()).toEqual({ 30: false, 37: true });
  });

  it('says Auto-flagged also lists a Needs review model carrying a real-person hash flag', async () => {
    await pg.query(`UPDATE "Model" SET meta = meta || $1::jsonb WHERE id IN (30, 32)`, [
      JSON.stringify({ textScanFlags: { minor: { redetected: redetected(daysAgo(1)) } } }),
    ]);
    const { items } = await needsReview({ limit: 20 });
    // 32's flag was confirmed, so Auto-flagged no longer lists it.
    expect(Object.fromEntries(items.map((r) => [r.modelId, r.alsoInAutoFlagged]))).toEqual({
      30: true,
      32: false,
    });
  });

  it('keeps an unreviewed flag past the minor review window: nothing presumes it correct', async () => {
    await seed(31, poiSnapshot('auto', daysAgo(40)));
    expect(await keys()).toEqual(['31:poi:hash', '30:poi:hash']);
    expect(await getFlaggedCount()).toBe(2);
  });

  it('counts the hash flag as a real-person flag in force, as the appeal resolver does', async () => {
    expect(await getModelAppealState(30)).toMatchObject({ poi: true });
    expect(await getModelAppealState(32)).toMatchObject({ poi: true });
    expect(await getModelAppealState(34)).toMatchObject({ poi: false });
  });
});

describe('text-scan auto-flags', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  const entry = (at: string, extra: object = {}) => ({
    workflowId: 'wf',
    reason: 'why',
    names: ['petite schoolgirl'],
    textHash: 'h-1',
    at,
    ...extra,
  });
  const seed = (
    id: number,
    userId: number,
    flags: { minor?: boolean; poi?: boolean },
    meta: object
  ) =>
    pg.query(
      `INSERT INTO "Model" (id, name, "userId", minor, poi, meta) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, `model ${id}`, userId, !!flags.minor, !!flags.poi, JSON.stringify(meta)]
    );
  const keys = async (filters: Partial<Parameters<typeof getFlaggedModels>[0]> = {}) =>
    flagKeys((await getFlaggedModels({ limit: 20, ...filters })).items);
  const onlyTextScan = { source: 'text-scan', flag: 'all', sort: 'oldest' } as const;

  beforeEach(async () => {
    // Both labels open on one model: a row per label.
    await seed(
      30,
      1,
      { minor: true, poi: true },
      {
        textScanFlags: { minor: entry(daysAgo(5)), poi: entry(daysAgo(4), { textHash: 'h-2' }) },
      }
    );
    // A hash sweep also flagged this minor flag: the hash row wins, the poi text-scan row stays.
    await seed(
      31,
      2,
      { minor: true, poi: true },
      {
        minorFlagSnapshot: { source: 'auto', at: daysAgo(3), prevNsfw: false },
        textScanFlags: { minor: entry(daysAgo(6)), poi: entry(daysAgo(6)) },
      }
    );
    // Not waiting: ruled (upheld, granted), held for review, lifted column, a stub with no workflow.
    await seed(
      32,
      1,
      { minor: true },
      { textScanFlags: { minor: entry(daysAgo(7), { appealUpheld: {} }) } }
    );
    await seed(
      33,
      1,
      { minor: true },
      { textScanFlags: { minor: entry(daysAgo(7), { appealGranted: {} }) } }
    );
    await seed(
      34,
      1,
      { minor: true },
      {
        textScanFlags: {
          minor: entry(daysAgo(7), { redetected: { workflowId: 'w', textHash: 'n' } }),
        },
      }
    );
    await seed(35, 1, {}, { textScanFlags: { minor: entry(daysAgo(7)) } });
    await seed(36, 1, { minor: true }, { textScanFlags: { minor: { rulings: [] } } });
  });

  it('lists each open label on its model, with the entry, and leaves the ruled and lifted ones out', async () => {
    const { items } = await getFlaggedModels({ limit: 20 });
    expect(flagKeys(items)).toEqual([
      // A hash minor flag and a text-scan real-person flag on one model: one row, both flags.
      '31:minor:hash',
      '31:poi:text-scan',
      '30:minor:text-scan',
      '30:poi:text-scan',
      // 34 is held for review rather than flagged: Needs review lists it, not Auto-flagged.
    ]);
    const row = items.find((r) => r.modelId === 30)!.flags.find((f) => f.label === 'poi')!;
    expect(row).toMatchObject({
      source: 'text-scan',
      textHash: 'h-2',
      daysLeft: null,
      redetected: null,
      scanEntry: expect.objectContaining({ reason: 'why', names: ['petite schoolgirl'] }),
    });
    expect(new Date(row.flaggedAt!).toISOString()).toBe(new Date(row.scanEntry!.at!).toISOString());
  });

  it('splits a model between tabs by state: its applied hash flag here, its held detection in Needs review', async () => {
    // A hash minor flag and a held real-person re-detection on one model.
    await seed(
      38,
      2,
      { minor: true, poi: true },
      {
        minorFlagSnapshot: { source: 'auto', at: daysAgo(2), prevNsfw: false },
        textScanFlags: {
          poi: {
            appealGranted: {},
            redetected: { workflowId: 'w', textHash: 'n', at: daysAgo(1) },
          },
        },
      }
    );
    const { items } = await getFlaggedModels({ limit: 20, search: { modelOrUserId: 38 } });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: '38',
      modelName: 'model 38',
      userId: 2,
      username: 'other',
      minor: true,
      poi: true,
    });
    expect(flagKeys(items)).toEqual(['38:minor:hash']);
    expect(items[0].alsoInNeedsReview).toBe(true);
    expect(await getFlaggedCount({ search: { modelOrUserId: 38 } })).toBe(1);
    const held = await needsReview({ limit: 20, search: { modelOrUserId: 38 } });
    expect(flagKeys(held.items)).toEqual(['38:poi:redetected']);
    expect(held.items[0].alsoInAutoFlagged).toBe(true);
  });

  it('lists a hash-flagged model once for minor, and still lists its poi text-scan row', async () => {
    const keysFor31 = (await keys()).filter((k) => k.startsWith('31:'));
    expect(keysFor31).toEqual(['31:minor:hash', '31:poi:text-scan']);
    expect(await keys({ filters: onlyTextScan })).not.toContain('31:minor:text-scan');
  });

  it('counts each source chip in one pass, a model in both counted once under All', async () => {
    // 31 carries a hash minor flag and a text-scan real-person flag.
    expect(await getFlaggedSourceCounts()).toEqual({ all: 2, hash: 1, 'text-scan': 2 });
    expect(await getFlaggedSourceCounts({ flag: 'poi' })).toEqual({
      all: 2,
      hash: 0,
      'text-scan': 2,
    });
    expect(await getFlaggedSourceCounts({ search: { modelOrUserId: 30 } })).toEqual({
      all: 1,
      hash: 0,
      'text-scan': 1,
    });
  });

  describe('a minor flag the hash sweep owns', () => {
    const textScan = async () => ({
      keys: await keys({ filters: onlyTextScan }),
      count: await getFlaggedCount({ source: 'text-scan' }),
    });

    it('is not relisted once its snapshot is past the review window', async () => {
      await seed(
        40,
        1,
        { minor: true },
        {
          minorFlagSnapshot: { source: 'auto', at: daysAgo(40), prevNsfw: true },
          textScanFlags: { minor: entry(daysAgo(41)) },
        }
      );
      const { keys: listed, count } = await textScan();
      expect(listed).not.toContain('40:minor:text-scan');
      expect(count).toBe(2);
    });

    it('is not relisted once a moderator confirmed it', async () => {
      await seed(
        41,
        1,
        { minor: true },
        {
          minorFlagSnapshot: { source: 'manual', at: daysAgo(2), prevNsfw: true },
          textScanFlags: { minor: entry(daysAgo(3)) },
        }
      );
      const { keys: listed, count } = await textScan();
      expect(listed).not.toContain('41:minor:text-scan');
      expect(count).toBe(2);
    });

    it('still lists the poi row of a model whose minor flag the hash sweep owns', async () => {
      await seed(
        42,
        1,
        { minor: true, poi: true },
        {
          minorFlagSnapshot: { source: 'auto', at: daysAgo(40), prevNsfw: true },
          textScanFlags: { minor: entry(daysAgo(41)), poi: entry(daysAgo(41)) },
        }
      );
      const { keys: listed, count } = await textScan();
      expect(listed).toContain('42:poi:text-scan');
      expect(listed).not.toContain('42:minor:text-scan');
      expect(count).toBe(3);
    });

    it('lists a text-scan minor flag whose snapshot the text scan wrote, in the list, the count and the chip', async () => {
      // Every text-scan minor flag carries one: setModelMinor snapshots with source 'text-scan'.
      await seed(
        44,
        1,
        { minor: true },
        {
          minorFlagSnapshot: { source: 'text-scan', at: daysAgo(3), prevNsfw: false },
          textScanFlags: { minor: entry(daysAgo(3)) },
        }
      );
      const { keys: listed, count } = await textScan();
      expect(listed).toContain('44:minor:text-scan');
      expect(count).toBe(3);
      expect(await getFlaggedCount({ search: { modelOrUserId: 44 } })).toBe(1);
      await seed(
        45,
        1,
        {},
        {
          textScanFlags: {
            minor: { redetected: { workflowId: 'w', textHash: 'n', at: daysAgo(1) } },
          },
        }
      );
      await pg.query(`UPDATE "Model" SET meta = meta || $1::jsonb WHERE id = 44`, [
        JSON.stringify({
          textScanFlags: {
            minor: entry(daysAgo(3)),
            poi: { redetected: { workflowId: 'w', textHash: 'n', at: daysAgo(1) } },
          },
        }),
      ]);
      const held = await needsReview({ limit: 20, search: { modelOrUserId: 44 } });
      expect(held.items[0]?.alsoInAutoFlagged).toBe(true);
    });

    it('lists a plain text-scan minor flag with no snapshot', async () => {
      await seed(43, 1, { minor: true }, { textScanFlags: { minor: entry(daysAgo(3)) } });
      const { keys: listed, count } = await textScan();
      expect(listed).toContain('43:minor:text-scan');
      expect(count).toBe(3);
    });
  });

  it('filters by source and by flag', async () => {
    expect(await keys({ filters: onlyTextScan })).toEqual([
      '31:poi:text-scan',
      '30:minor:text-scan',
      '30:poi:text-scan',
    ]);
    expect(await keys({ filters: { ...onlyTextScan, flag: 'poi' } })).toEqual([
      '31:poi:text-scan',
      '30:poi:text-scan',
    ]);
    expect(await keys({ filters: { source: 'hash', flag: 'all', sort: 'oldest' } })).toEqual([
      '31:minor:hash',
    ]);
  });

  it('shows the latest scan on a row with a text-scan flag only', async () => {
    await pg.exec(`INSERT INTO "EntityModeration" ("entityType", "entityId", "result")
      VALUES ('Model', 30, '{"labels":{"minor":{"detected":false,"reason":"gone"}}}'),
             ('Model', 34, '{"labels":{"minor":{"detected":false,"reason":"gone"}}}')`);
    const { items } = await getFlaggedModels({ limit: 20 });
    const byModel = Object.fromEntries(items.map((r) => [r.modelId, r.latestScan]));
    expect(byModel[30]?.minor).toMatchObject({
      detected: false,
      reason: 'gone',
      source: 'main',
    });
    expect(byModel[30]?.poi).toBeNull();
    // A held re-detection only is not listed here, and Needs review carries no latest scan.
    expect(byModel[34]).toBeUndefined();
    const held = await needsReview({ limit: 20 });
    expect(held.items.find((r) => r.modelId === 34)?.latestScan).toBeNull();
  });

  it('carries the scan rows on rows with a scan flag, for provenance and the text hash, and not on hash-only rows', async () => {
    await seed(37, 1, { minor: true }, { minorFlagSnapshot: { source: 'auto', at: daysAgo(1) } });
    await pg.exec(`INSERT INTO "EntityModeration" ("entityType", "entityId", "workflowId", "status", "result", "updatedAt")
      VALUES ('Model:search', 30, 'wf', 'Succeeded', '{"textHash":"h-1"}', '2026-10-01T00:00:00'),
             ('Model', 31, 'wf-x', 'Succeeded', '{"textHash":"h-9"}', '2026-10-01T00:00:00'),
             ('Model', 37, 'wf-y', 'Succeeded', '{"textHash":"h-7"}', '2026-10-01T00:00:00')`);
    // The column holds UTC without a zone: the rendered time must not follow the session's zone.
    await pg.exec(`SET TIME ZONE 'America/New_York'`);
    const { items } = await getFlaggedModels({ limit: 20 });
    const byModel = Object.fromEntries(items.map((r) => [r.modelId, r.scanRows]));
    expect(byModel[30]).toEqual({
      main: null,
      search: {
        workflowId: 'wf',
        textHash: 'h-1',
        status: 'Succeeded',
        updatedAt: '2026-10-01T00:00:00.000Z',
      },
    });
    expect(byModel[31]?.main).toMatchObject({ workflowId: 'wf-x', textHash: 'h-9' });
    expect(byModel[37]).toBeNull();
  });

  it('counts the same population the list shows', async () => {
    const textScan = (q: Parameters<typeof getFlaggedCount>[0] = {}) =>
      getFlaggedCount({ source: 'text-scan', ...q });
    expect(await textScan()).toBe(2);
    expect(await textScan({ flag: 'poi' })).toBe(2);
    expect(await textScan({ search: { modelOrUserId: 1 } })).toBe(1);
    expect(await textScan({ search: { text: 'other' } })).toBe(1);
    // Models, not labels: 30 and 31 each carry two flags and count once.
    expect(await getFlaggedCount()).toBe(2);
    expect(await getFlaggedCount({ source: 'text-scan' })).toBe(2);
    expect(await getFlaggedCount({ source: 'hash' })).toBe(1);
    expect(await getFlaggedCount({ source: 'text-scan', flag: 'minor' })).toBe(1);
  });
});

describe('reviewDaysLeft', () => {
  const now = Date.parse('2026-10-16T12:00:00Z');
  it('counts whole days remaining, rounding a part day up', () => {
    expect(reviewDaysLeft('2026-10-16T11:00:00Z', now)).toBe(30);
    expect(reviewDaysLeft('2026-10-01T12:00:00Z', now)).toBe(15);
    expect(reviewDaysLeft('2026-09-16T13:00:00Z', now)).toBe(1);
  });

  it('never goes below zero', () => {
    expect(reviewDaysLeft('2026-08-01T00:00:00Z', now)).toBe(0);
  });
});
