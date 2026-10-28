import type { PGlite } from '@electric-sql/pglite';
import { freshPglite } from '../../../test/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pgliteDialect } from './abuse-detection-pglite.harness';
import {
  appealFacets,
  DEFAULT_APPEAL_FILTERS,
  type AppealFilters,
} from '../../minor-flags/appeal-filters';

/** Runs the appeals queue SQL on real Postgres; text-only SQL tests can't see a predicate that compiles but selects the wrong rows. */

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

const { getMinorFlagAppealsForReview, getMinorFlagAppealGroups } = await import(
  '../minor-hash.service'
);

const SCHEMA = `
CREATE TABLE "User" ("id" INTEGER PRIMARY KEY, "username" TEXT);
CREATE TABLE "Model" (
  "id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL, "userId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Published', "type" TEXT NOT NULL DEFAULT 'LORA',
  "minor" BOOLEAN NOT NULL DEFAULT FALSE, "poi" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01', "meta" JSONB,
  "lockedProperties" TEXT[] NOT NULL DEFAULT '{}'
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMPTZ NOT NULL,
  "category" TEXT, "context" JSONB
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER, "baseModel" TEXT NOT NULL,
  "trainedWords" TEXT[] NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'Published',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01'
);
CREATE TABLE "ModelFile" (
  "id" INTEGER PRIMARY KEY, "modelVersionId" INTEGER NOT NULL, "type" TEXT NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT now(), "name" TEXT NOT NULL DEFAULT 'file',
  "sizeKB" DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE "ModelFileHash" ("fileId" INTEGER NOT NULL, "type" TEXT NOT NULL, "hash" TEXT NOT NULL);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "modelVersionId" INTEGER,
  "publishedAt" TIMESTAMPTZ
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "postId" INTEGER, "index" INTEGER, "type" TEXT NOT NULL DEFAULT 'image',
  "minor" BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TagsOnModels" ("modelId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMPTZ NOT NULL
);
CREATE TABLE "EntityModeration" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "workflowId" TEXT, "status" TEXT NOT NULL DEFAULT 'Pending', "result" JSONB,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT '2026-01-01',
  UNIQUE ("entityType", "entityId")
);
`;

const snapshot = (source: string | null, at: string, extra: Record<string, unknown> = {}) =>
  source === null ? null : { minorFlagSnapshot: { source, at, ...extra } };

type Seed = {
  id: number;
  userId: number;
  minor: boolean;
  poi: boolean;
  meta: unknown;
  appealAt: string;
};

// Appeal order (oldest first): 1..7. Flag order (newest first): 3,2,6,1,5; models 4 and 7 have no snapshot.
// Model 7 is a text-scan real-person flag, which writes textScanFlags and no snapshot.
const MODELS: Seed[] = [
  {
    id: 1,
    userId: 10,
    minor: true,
    poi: false,
    meta: snapshot('manual', '2026-09-20'),
    appealAt: '2026-10-01',
  },
  {
    id: 2,
    userId: 11,
    minor: true,
    poi: true,
    meta: snapshot('auto', '2026-09-25'),
    appealAt: '2026-10-02',
  },
  {
    id: 3,
    userId: 12,
    minor: false,
    poi: true,
    meta: snapshot('text-scan', '2026-09-30'),
    appealAt: '2026-10-03',
  },
  { id: 4, userId: 13, minor: false, poi: false, meta: null, appealAt: '2026-10-04' },
  {
    id: 5,
    userId: 10,
    minor: false,
    poi: false,
    meta: snapshot('manual', '2026-09-10', { confirmedFrom: 'auto' }),
    appealAt: '2026-10-05',
  },
  {
    id: 6,
    userId: 14,
    minor: true,
    poi: false,
    meta: snapshot('legacy', '2026-09-22'),
    appealAt: '2026-10-06',
  },
  {
    id: 7,
    userId: 15,
    minor: false,
    poi: true,
    meta: { textScanFlags: { poi: { workflowId: 'wf-1' } } },
    appealAt: '2026-10-07',
  },
];

let db: PGlite;

beforeEach(async () => {
  db = await freshPglite();
  await db.exec(SCHEMA);
  for (const [id, username] of [
    [10, 'owner'],
    [11, 'b'],
    [12, 'c'],
    [13, 'd'],
    [14, 'e'],
    [15, 'f'],
    [99, 'modA'],
  ])
    await db.query(`INSERT INTO "User" ("id","username") VALUES ($1,$2)`, [id, username]);
  for (const m of MODELS) {
    await db.query(
      `INSERT INTO "Model" ("id","name","userId","minor","poi","meta") VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [m.id, `model ${m.id}`, m.userId, m.minor, m.poi, m.meta ? JSON.stringify(m.meta) : null]
    );
    await db.query(
      `INSERT INTO "Appeal" ("id","userId","entityType","entityId","createdAt") VALUES ($1,$2,'Model',$3,$4)`,
      [m.id, m.userId, m.id, m.appealAt]
    );
  }
  await db.query(
    `INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt") VALUES
      (50, 11, 'Model', 2, 'Approved', '2026-08-01'),
      (51, 10, 'Image', 1, 'Pending', '2026-08-01')`
  );
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const ids = async (
  filters: Partial<AppealFilters>,
  extra: { limit?: number; offset?: number } = {}
) => {
  const { items } = await getMinorFlagAppealsForReview({
    limit: 50,
    ...extra,
    filters: { ...DEFAULT_APPEAL_FILTERS, ...filters },
  });
  return items.map((i) => i.modelId);
};

describe('source filter', () => {
  it.each([
    ['all', [1, 2, 3, 4, 5, 6, 7]],
    ['text-scan', [3, 7]],
    ['hash', [2]],
    ['moderator', [1, 5]],
  ] as const)('%s', async (source, expected) => {
    expect(await ids({ source })).toEqual(expected);
  });
});

describe('text-scan real-person flag with no snapshot', () => {
  it('reads as a text-scan source in the row, the filter and the counts', async () => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    expect(items.find((i) => i.modelId === 7)?.flagSource).toBe('text-scan');
    expect(await ids({ source: 'text-scan' })).toContain(7);
  });
});

describe('real-person hash flag', () => {
  const rowFor = async (modelId: number) =>
    (await getMinorFlagAppealsForReview({ limit: 50 })).items.find((i) => i.modelId === modelId)!;
  const setMeta = (id: number, meta: object) =>
    db.query(`UPDATE "Model" SET poi = TRUE, meta = $2::jsonb WHERE id = $1`, [
      id,
      JSON.stringify(meta),
    ]);

  it('reads its source from the real-person snapshot when the model has no minor one', async () => {
    await setMeta(4, { poiFlagSnapshot: { source: 'auto', at: '2026-09-28T00:00:00Z' } });
    const row = await rowFor(4);
    expect(row).toMatchObject({ flagSource: 'auto', flagSnapshotLabel: 'poi', poiHashFlag: true });
    expect(new Date(row.flaggedAt!).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(new Date(row.poiFlaggedAt!).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(await ids({ source: 'hash' })).toEqual([2, 4]);
    expect(await ids({ flag: 'poi' })).toContain(4);
  });

  it('keeps the hash origin of a confirmed flag, and names the moderator who confirmed it', async () => {
    await setMeta(4, {
      poiFlagSnapshot: { source: 'manual', confirmedFrom: 'auto', at: '2026-09-28T00:00:00Z' },
    });
    await db.query(
      `INSERT INTO "ModActivity" ("userId","activity","entityType","entityId","createdAt") VALUES
        (99, 'setPoi', 'model', 4, '2026-09-29'), (99, 'setMinor', 'model', 4, '2026-09-30')`
    );
    const row = await rowFor(4);
    expect(row).toMatchObject({ flagSource: 'manual', flagConfirmedFrom: 'auto' });
    expect(row.flaggedByUsername).toBe('modA');
    expect(new Date(row.flaggedByAt!).toISOString()).toBe('2026-09-29T00:00:00.000Z');
    expect(await ids({ source: 'moderator' })).toContain(4);
  });

  it('a minor snapshot names the row; the real-person hash flag is still marked', async () => {
    await setMeta(2, {
      minorFlagSnapshot: { source: 'manual', at: '2026-09-25' },
      poiFlagSnapshot: { source: 'auto', at: '2026-09-27T00:00:00Z' },
    });
    expect(await rowFor(2)).toMatchObject({
      flagSource: 'manual',
      flagSnapshotLabel: 'minor',
      poiHashFlag: true,
    });
  });

  it('marks nothing on a model with no real-person snapshot', async () => {
    expect(await rowFor(7)).toMatchObject({ flagSnapshotLabel: null, poiHashFlag: false });
    expect(await rowFor(4)).toMatchObject({ poiHashFlag: false });
  });
});

describe('flag filter', () => {
  it.each([
    ['all', [1, 2, 3, 4, 5, 6, 7]],
    ['minor', [1, 2, 6]],
    ['poi', [2, 3, 7]],
  ] as const)('%s', async (flag, expected) => {
    expect(await ids({ flag })).toEqual(expected);
  });

  it('combines with the source filter', async () => {
    expect(await ids({ source: 'moderator', flag: 'minor' })).toEqual([1]);
    expect(await ids({ source: 'text-scan', flag: 'minor' })).toEqual([]);
  });
});

describe('sort', () => {
  it('oldest appeal first by default', async () => {
    expect(await ids({})).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
  it('newest appeal first', async () => {
    expect(await ids({ sort: 'newest' })).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });
  it('most recently flagged first, unflagged-since-never last', async () => {
    expect(await ids({ sort: 'flagged' })).toEqual([3, 2, 6, 1, 5, 4, 7]);
  });
});

describe('paging under a filter', () => {
  it.each([1, 2, 3])('reaches every filtered row once at %i per page', async (limit) => {
    const seen: number[] = [];
    for (let offset = 0; offset < 20; offset += limit) {
      const { items, hasMore } = await getMinorFlagAppealsForReview({
        limit,
        offset,
        filters: { ...DEFAULT_APPEAL_FILTERS, flag: 'minor', sort: 'newest' },
      });
      seen.push(...items.map((i) => i.modelId));
      if (!hasMore) break;
    }
    expect(seen).toEqual([6, 2, 1]);
  });
});

describe('search', () => {
  it('narrows within a filter, by username and by id', async () => {
    expect(
      await getMinorFlagAppealsForReview({ limit: 50, search: { text: 'OWNER' } }).then((r) =>
        r.items.map((i) => i.modelId)
      )
    ).toEqual([1, 5]);
    const { items } = await getMinorFlagAppealsForReview({
      limit: 50,
      search: { modelOrUserId: 10 },
      filters: { ...DEFAULT_APPEAL_FILTERS, source: 'moderator', flag: 'minor' },
    });
    expect(items.map((i) => i.modelId)).toEqual([1]);
  });

  it('matches a model name as a case-insensitive substring, wildcards taken literally', async () => {
    await db.query(`UPDATE "Model" SET name = 'Anime 10%_Girl' WHERE id = 5`);
    const ids = async (text: string) =>
      (await getMinorFlagAppealsForReview({ limit: 50, search: { text } })).items.map(
        (i) => i.modelId
      );

    expect(await ids('aNiMe')).toEqual([5]);
    expect(await ids('10%')).toEqual([5]);
    // Unescaped, `_` would match the space in "model 1".
    expect(await ids('l_1')).toEqual([]);
    const f = appealFacets(
      await getMinorFlagAppealGroups({ search: { text: 'anime' } }),
      DEFAULT_APPEAL_FILTERS
    );
    expect(f.source.all).toBe(1);
  });
});

describe('facet groups', () => {
  it('yields counts that match what each filter returns', async () => {
    const groups = await getMinorFlagAppealGroups({});
    const f = appealFacets(groups, DEFAULT_APPEAL_FILTERS);
    expect(f.source).toEqual({ all: 7, 'text-scan': 2, hash: 1, moderator: 2 });
    expect(f.flag).toEqual({ all: 7, minor: 3, poi: 3, lock: 0 });
  });

  it('honours the search', async () => {
    const f = appealFacets(
      await getMinorFlagAppealGroups({ search: { text: 'owner' } }),
      DEFAULT_APPEAL_FILTERS
    );
    expect(f.source.all).toBe(2);
  });
});

describe('row context', () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "ModelVersion" ("id","modelId","index","baseModel","trainedWords","status","createdAt") VALUES
        (100, 1, 1, 'SD 1.5', '{old}', 'Published', '2026-02-01'),
        (101, 1, 2, 'Pony', '{a,b,c,d,e,f,g,h,i,j}', 'Published', '2026-03-01'),
        (102, 1, 3, 'Draft base', '{draft}', 'Draft', '2026-04-01');
      INSERT INTO "Tag" ("id","name") VALUES (1,'zeta'),(2,'alpha');
      INSERT INTO "TagsOnModels" ("modelId","tagId") VALUES (1,1),(1,2);
      INSERT INTO "Post" ("id","userId","modelVersionId","publishedAt") VALUES
        (200, 10, 100, '2026-02-02'), (201, 10, 101, '2026-03-02'),
        (202, 10, 101, NULL), (203, 77, 101, '2026-03-03');
      INSERT INTO "Image" ("id","url","nsfwLevel","postId","index","type") VALUES
        (1, 'u-a', 1, 200, 0, 'image'), (2, 'u-b', 4, 200, 1, 'image'), (3, 'u-c', 1, 201, 0, 'image'),
        (4, 'u-d', 1, 201, 1, 'image'), (5, 'u-e', 1, 201, 2, 'image'),
        (6, 'u-draft', 1, 202, 0, 'image'), (7, 'u-other', 1, 203, 0, 'image'), (8, 'u-vid', 1, 200, 5, 'video');
      INSERT INTO "ModActivity" ("userId","activity","entityType","entityId","createdAt") VALUES
        (99, 'setMinor', 'model', 1, '2026-09-19'), (99, 'setMinor', 'model', 1, '2026-09-20T00:00:00Z'),
        (99, 'setMinor', 'model', 2, '2026-09-25');
      INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt") VALUES
        (60, 10, 'Model', 7, 'Rejected', '2026-07-01'), (61, 10, 'Model', 8, 'Rejected', '2026-07-02'),
        (62, 10, 'Model', 9, 'Approved', '2026-07-03');
    `);
  });

  const rowFor = async (modelId: number) => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    return items.find((i) => i.modelId === modelId)!;
  };

  it('takes base model and capped trained words from the latest published version', async () => {
    const row = await rowFor(1);
    expect(row.baseModel).toBe('Pony');
    expect(row.trainedWords).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
  });

  it('reports the full tag and trained-word counts, not the capped arrays', async () => {
    const row = await rowFor(1);
    expect(row.trainedWordCount).toBe(10);
    expect(row.tagCount).toBe(2);
    expect(await rowFor(2)).toMatchObject({ trainedWordCount: 0, tagCount: 0 });
  });

  it('lists tags sorted by name', async () => {
    expect((await rowFor(1)).tags).toEqual(['alpha', 'zeta']);
    expect((await rowFor(2)).tags).toEqual([]);
  });

  it('serves up to four owner-posted images and videos, published posts first, in version then post then image order', async () => {
    const row = await rowFor(1);
    expect(row.coverImages.map((i) => i.url)).toEqual(['u-a', 'u-b', 'u-vid', 'u-c']);
    expect(row.coverImages[1]).toEqual({
      id: 2,
      url: 'u-b',
      nsfwLevel: 4,
      type: 'image',
      minor: false,
      acceptableMinor: false,
    });
    expect((await rowFor(2)).coverImages).toEqual([]);
  });

  it('serves images from unpublished posts, after any published ones', async () => {
    await db.exec(`
      INSERT INTO "ModelVersion" ("id","modelId","index","baseModel","trainedWords","status","createdAt") VALUES
        (103, 3, 1, 'Illustrious', '{}', 'Unpublished', '2026-05-01'),
        (104, 4, 1, 'Illustrious', '{}', 'Unpublished', '2026-05-01'),
        (105, 4, 2, 'Illustrious', '{}', 'Published', '2026-05-02');
      INSERT INTO "Post" ("id","userId","modelVersionId","publishedAt") VALUES
        (204, 12, 103, NULL), (205, 13, 104, NULL), (206, 13, 105, '2026-05-03');
      INSERT INTO "Image" ("id","url","nsfwLevel","postId","index","type") VALUES
        (9, 'u-unpub', 1, 204, 0, 'image'), (10, 'u-early-unpub', 1, 205, 0, 'image'),
        (11, 'u-late-pub', 1, 206, 0, 'image');
    `);
    expect((await rowFor(3)).coverImages).toEqual([
      { id: 9, url: 'u-unpub', nsfwLevel: 1, type: 'image', minor: false, acceptableMinor: false },
    ]);
    expect((await rowFor(4)).coverImages.map((i) => i.url)).toEqual([
      'u-late-pub',
      'u-early-unpub',
    ]);
  });

  it('names the latest moderator to set minor, for manual flags only', async () => {
    const row = await rowFor(1);
    expect(row.flaggedByUsername).toBe('modA');
    expect(new Date(row.flaggedByAt!).toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect((await rowFor(2)).flaggedByUsername).toBeNull();
  });

  it("counts the owner's other flagged models and past appeals by status", async () => {
    const row = await rowFor(1);
    expect(row.otherFlaggedModels).toBe(0);
    expect(row.pastAppeals).toEqual({ approved: 1, rejected: 2, void: 0, pending: 1 });
    expect((await rowFor(5)).otherFlaggedModels).toBe(1);
  });

  it('counts model appeals on other models sharing a SHA256 with this one, by status', async () => {
    const withHash = async (
      modelId: number,
      hash: string,
      { hashType = 'SHA256', fileType = 'Model' } = {}
    ) => {
      await db.query(
        `INSERT INTO "ModelVersion" ("id","modelId","baseModel") VALUES ($1,$2,'SDXL')`,
        [900 + modelId, modelId]
      );
      await db.query(`INSERT INTO "ModelFile" ("id","modelVersionId","type") VALUES ($1, $1, $2)`, [
        900 + modelId,
        fileType,
      ]);
      await db.query(`INSERT INTO "ModelFileHash" VALUES ($1, $2, $3)`, [
        900 + modelId,
        hashType,
        hash,
      ]);
    };
    // Models 1, 2 and 3 carry one file. Model 4 has other bytes, and its AutoV2 hash that equals the
    // shared value does not count: only SHA256 identifies the file.
    await withHash(1, 'shared');
    await withHash(2, 'shared');
    await withHash(3, 'shared');
    await withHash(4, 'other');
    await withHash(5, 'shared', { hashType: 'AutoV2' });
    // Model 6 shares only a VAE: a shared config or VAE must not link unrelated models.
    await withHash(6, 'shared', { fileType: 'VAE' });
    await db.exec(`
      INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt","category") VALUES
        (70, 99, 'Model', 3, 'Rejected', '2026-06-01', NULL),
        (71, 99, 'Model', 3, 'Rejected', '2026-06-02', NULL),
        (72, 99, 'Model', 4, 'Rejected', '2026-06-03', NULL),
        (73, 99, 'Model', 3, 'Rejected', '2026-06-04', 'Model'),
        (74, 99, 'Image', 3, 'Rejected', '2026-06-05', NULL),
        (75, 99, 'Model', 5, 'Rejected', '2026-06-06', NULL),
        (76, 99, 'Model', 6, 'Rejected', '2026-06-07', NULL);
    `);
    // Model 2 holds the seeded Approved appeal and its own pending one; model 3 its pending one plus
    // the two rejections. Model 1's own appeal, the category and Image appeals, and models 4, 5 and 6 are out.
    expect((await rowFor(1)).sameFileAppeals).toEqual({
      approved: 1,
      rejected: 2,
      void: 0,
      pending: 2,
      models: 2,
    });
    // Model 4 shares nothing; a model with no file at all has nothing to match either.
    expect((await rowFor(4)).sameFileAppeals).toEqual({
      approved: 0,
      rejected: 0,
      void: 0,
      pending: 0,
      models: 0,
    });
    expect((await rowFor(6)).sameFileAppeals.models).toBe(0);
  });

  it("numbers the appeal among the uploader's model appeals this year, any status", async () => {
    // Owner 10: three July appeals, then this one (Oct 1), then model 5's (Oct 5); the Image appeal
    // and appeals from last year do not count.
    await db.exec(`INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt") VALUES
      (63, 10, 'Model', 9, 'Rejected', '2025-12-30')`);
    expect((await rowFor(1)).appealNthThisYear).toBe(4);
    expect((await rowFor(5)).appealNthThisYear).toBe(5);
    expect((await rowFor(2)).appealNthThisYear).toBe(2);
    expect((await rowFor(4)).appealNthThisYear).toBe(1);
  });
});

describe('also in Auto-flagged and Needs review', () => {
  const also = async () => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    return Object.fromEntries(
      items.map((i) => [i.modelId, [i.alsoInAutoFlagged, i.alsoInNeedsReview]])
    );
  };
  const withFile = async (modelId: number, hash: string) => {
    await db.query(
      `INSERT INTO "ModelVersion" ("id","modelId","baseModel") VALUES ($1, $2, 'SDXL')`,
      [modelId + 100, modelId]
    );
    await db.query(
      `INSERT INTO "ModelFile" ("id","modelVersionId","type") VALUES ($1, $1, 'Model')`,
      [modelId + 100]
    );
    await db.query(`INSERT INTO "ModelFileHash" VALUES ($1, 'SHA256', $2)`, [modelId + 100, hash]);
  };

  it('marks applied flags as Auto-flagged and leads nothing was applied for as Needs review', async () => {
    // Model 2: a hash auto-flag inside its review window. Model 7: an open text-scan real-person
    // flag. Model 4: a held re-detection.
    await db.query(`UPDATE "Model" SET meta = $1::jsonb WHERE id = 2`, [
      JSON.stringify(snapshot('auto', new Date(Date.now() - 86_400_000).toISOString())),
    ]);
    await db.query(`UPDATE "Model" SET meta = $1::jsonb WHERE id = 4`, [
      JSON.stringify({
        textScanFlags: { minor: { redetected: { workflowId: 'w', textHash: 'h' } } },
      }),
    ]);
    expect(await also()).toEqual({
      1: [false, false],
      2: [true, false],
      3: [false, false],
      4: [false, true],
      5: [false, false],
      6: [false, false],
      7: [true, false],
    });
  });

  it("marks a file match: an unflagged model sharing a file with another uploader's seed", async () => {
    // Model 1 becomes a moderator's minor seed (user 10); model 4 (user 13) and model 5 (user 10,
    // the seed's own uploader, so automation's business) carry the same file.
    await db.query(`UPDATE "Model" SET "lockedProperties" = '{minor}' WHERE id = 1`);
    // The File matches predicates read keys off meta, as the queue does, so it is never null here.
    await db.query(`UPDATE "Model" SET meta = '{}'::jsonb WHERE id = 4`);
    await withFile(1, 'aa');
    await withFile(4, 'aa');
    await withFile(5, 'aa');
    const result = await also();
    expect(result[4]).toEqual([false, true]);
    expect(result[5]).toEqual([false, false]);
    // A dismissed match is no longer waiting.
    await db.query(`UPDATE "Model" SET meta = '{"minorHashDismissed": true}'::jsonb WHERE id = 4`);
    expect((await also())[4]).toEqual([false, false]);
  });

  it('drops a hash flag once its review window has closed', async () => {
    await db.query(`UPDATE "Model" SET meta = $1::jsonb WHERE id = 2`, [
      JSON.stringify(snapshot('auto', '2020-01-01T00:00:00Z')),
    ]);
    expect((await also())[2]).toEqual([false, false]);
  });
});

describe('scan rows', () => {
  it('carries both text-scan rows with their workflow and text hash', async () => {
    await db.exec(`INSERT INTO "EntityModeration" ("entityType","entityId","workflowId","status","result","updatedAt") VALUES
      ('Model', 7, 'wf-1', 'Succeeded', '{"textHash": "h1"}', '2026-10-08T01:02:03.456'),
      ('Model:search', 7, 'wf-2', 'Pending', NULL, '2026-10-09T00:00:00')`);
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    expect(items.find((i) => i.modelId === 7)!.scanRows).toEqual({
      main: {
        workflowId: 'wf-1',
        textHash: 'h1',
        status: 'Succeeded',
        updatedAt: '2026-10-08T01:02:03.456Z',
      },
      search: {
        workflowId: 'wf-2',
        textHash: null,
        status: 'Pending',
        updatedAt: '2026-10-09T00:00:00.000Z',
      },
    });
    expect(items.find((i) => i.modelId === 1)!.scanRows).toEqual({ main: null, search: null });
  });
});

describe('latest scan', () => {
  const scanRow = (labels: Record<string, unknown>) => JSON.stringify({ version: 1, labels });
  const insert = (rows: [string, number, string, string | null, string][]) =>
    db.query(
      `INSERT INTO "EntityModeration" ("entityType","entityId","status","result","updatedAt")
       SELECT * FROM jsonb_to_recordset($1::jsonb)
         AS x("entityType" text, "entityId" int, status text, result jsonb, "updatedAt" timestamp)`,
      [
        JSON.stringify(
          rows.map(([entityType, entityId, status, result, updatedAt]) => ({
            entityType,
            entityId,
            status,
            result: result === null ? null : JSON.parse(result),
            updatedAt,
          }))
        ),
      ]
    );

  const scanFor = async (modelId: number) => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    return items.find((i) => i.modelId === modelId)!.latestScan;
  };

  it('takes each label from the web-search row when it is the newest succeeded one', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'stale main poi' } }),
        '2026-10-01T00:00:00Z',
      ],
      [
        'Model:search',
        7,
        'Succeeded',
        scanRow({
          poi: { detected: false, names: [], reason: 'No real person named.' },
          minor: { detected: false, reason: 'No age given.' },
        }),
        '2026-10-02T00:00:00Z',
      ],
    ]);
    const scan = await scanFor(7);
    expect(scan).toMatchObject({
      poi: {
        detected: false,
        reason: 'No real person named.',
        source: 'web search',
        status: 'Succeeded',
      },
      minor: { detected: false, reason: 'No age given.', source: 'web search' },
    });
    expect(new Date(scan!.poi!.updatedAt).toISOString()).toBe('2026-10-02T00:00:00.000Z');
  });

  it('serializes updatedAt as a UTC instant', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'Names an actor.' } }),
        '2026-10-14T20:39:32.167Z',
      ],
    ]);
    const { updatedAt } = (await scanFor(7))!.poi!;
    expect(updatedAt).toBe('2026-10-14T20:39:32.167Z');
    expect(new Date(updatedAt).getTime()).toBe(Date.UTC(2026, 9, 14, 20, 39, 32, 167));
  });

  it('prefers a newer succeeded main verdict over a stale succeeded web-search one', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: false, reason: 'Fresh main.' } }),
        '2026-10-05T00:00:00Z',
      ],
      [
        'Model:search',
        7,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'Stale search.' } }),
        '2026-10-02T00:00:00Z',
      ],
    ]);
    expect(await scanFor(7)).toMatchObject({
      poi: { detected: false, reason: 'Fresh main.', source: 'main', status: 'Succeeded' },
      minor: null,
    });
  });

  it('falls back to the main verdict when the web-search row is pending with no result', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'Names an actor.' } }),
        '2026-10-01T00:00:00Z',
      ],
      ['Model:search', 7, 'Pending', null, '2026-10-06T00:00:00Z'],
    ]);
    expect(await scanFor(7)).toMatchObject({
      poi: { detected: true, reason: 'Names an actor.', source: 'main', status: 'Succeeded' },
    });
  });

  it('prefers a succeeded verdict over a newer one from an unfinished rescan', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'Main.' } }),
        '2026-10-01T00:00:00Z',
      ],
      [
        'Model:search',
        7,
        'Failed',
        scanRow({ poi: { detected: false, reason: 'Old search.' } }),
        '2026-10-06T00:00:00Z',
      ],
    ]);
    expect(await scanFor(7)).toMatchObject({ poi: { reason: 'Main.', source: 'main' } });
  });

  it('shows an unfinished row verdict, with its status, when no succeeded row carries the label', async () => {
    await insert([
      [
        'Model:search',
        7,
        'Pending',
        scanRow({ poi: { detected: true, reason: 'Last verdict.' } }),
        '2026-10-06T00:00:00Z',
      ],
    ]);
    expect(await scanFor(7)).toMatchObject({
      poi: { detected: true, reason: 'Last verdict.', source: 'web search', status: 'Pending' },
      minor: null,
    });
  });

  it('reads a non-boolean detected as no verdict instead of failing the query', async () => {
    await insert([
      [
        'Model',
        7,
        'Succeeded',
        scanRow({ poi: { detected: 'yes', reason: 'Odd.' } }),
        '2026-10-01T00:00:00Z',
      ],
    ]);
    expect(await scanFor(7)).toMatchObject({ poi: { detected: null, reason: 'Odd.' } });
  });

  it('is null when no row carries a poi/minor verdict', async () => {
    await insert([
      [
        'Model',
        3,
        'Succeeded',
        scanRow({ nsfw: { level: 'none', reason: 'Clean.' } }),
        '2026-10-03T00:00:00Z',
      ],
      [
        'Image',
        1,
        'Succeeded',
        scanRow({ poi: { detected: true, reason: 'x' } }),
        '2026-10-04T00:00:00Z',
      ],
    ]);
    expect(await scanFor(3)).toBeNull();
    expect(await scanFor(1)).toBeNull();
  });
});

// An owner's request to review a locked setting, on a model with no flag.
describe('lock review rows', () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Model" ("id","name","userId","minor","poi","lockedProperties") VALUES
        (9, 'model 9', 10, false, false, '{nsfw,tags}');
      INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt","context") VALUES
        (70, 10, 'Model', 9, 'Pending', '2026-10-08',
         '{"kind":"lock-review","locks":["nsfw"]}'::jsonb);
    `);
  });

  it('list under Locked setting and All, never under a flag', async () => {
    expect(await ids({ flag: 'lock' })).toEqual([9]);
    expect(await ids({ flag: 'all' })).toContain(9);
    expect(await ids({ flag: 'minor' })).not.toContain(9);
    expect(await ids({ flag: 'poi' })).not.toContain(9);
  });

  it('carry the settings asked about, and only on the lock review', async () => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    expect(items.find((i) => i.modelId === 9)).toMatchObject({
      lockReview: ['nsfw'],
      lockedProperties: ['nsfw', 'tags'],
    });
    expect(items.find((i) => i.modelId === 1)!.lockReview).toBeNull();
  });

  it('are counted under Locked setting in the facets', async () => {
    const f = appealFacets(await getMinorFlagAppealGroups({}), DEFAULT_APPEAL_FILTERS);
    expect(f.flag).toMatchObject({ all: 8, lock: 1, minor: 3, poi: 3 });
  });
});

// A site-form appeal on a model (category set) is about an unpublish, not a flag: it must not be
// worked here, counted here, or read as the owner's flag-appeal history.
describe('site appeal form rows', () => {
  beforeEach(async () => {
    await db.exec(`
      INSERT INTO "Model" ("id","name","userId","minor","poi","meta") VALUES
        (8, 'model 8', 10, true, false, '${JSON.stringify(
          snapshot('moderator', '2026-09-20')
        )}'::jsonb);
      INSERT INTO "Appeal" ("id","userId","entityType","entityId","status","createdAt","category") VALUES
        (60, 10, 'Model', 8, 'Pending', '2026-10-08', 'Model'),
        (61, 10, 'Model', 1, 'Pending', '2026-10-08', 'Model');
    `);
  });

  it('are not listed, even on a flagged model or one with a flag appeal', async () => {
    expect(await ids({ source: 'all' })).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('are not counted in the facets', async () => {
    const f = appealFacets(await getMinorFlagAppealGroups({}), DEFAULT_APPEAL_FILTERS);
    expect(f.source.all).toBe(7);
  });

  it("are not counted in the owner's past appeals", async () => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    expect(items.find((i) => i.modelId === 1)!.pastAppeals).toEqual({
      approved: 0,
      rejected: 0,
      void: 0,
      pending: 1,
    });
  });
});
