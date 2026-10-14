import { PGlite } from '@electric-sql/pglite';
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
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01', "meta" JSONB
);
CREATE TABLE "Appeal" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL, "status" TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMPTZ NOT NULL
);
CREATE TABLE "ModelVersion" (
  "id" INTEGER PRIMARY KEY, "modelId" INTEGER NOT NULL, "index" INTEGER, "baseModel" TEXT NOT NULL,
  "trainedWords" TEXT[] NOT NULL DEFAULT '{}', "status" TEXT NOT NULL DEFAULT 'Published',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT '2026-01-01'
);
CREATE TABLE "Post" (
  "id" INTEGER PRIMARY KEY, "userId" INTEGER NOT NULL, "modelVersionId" INTEGER,
  "publishedAt" TIMESTAMPTZ
);
CREATE TABLE "Image" (
  "id" INTEGER PRIMARY KEY, "url" TEXT NOT NULL, "nsfwLevel" INTEGER NOT NULL DEFAULT 1,
  "postId" INTEGER, "index" INTEGER, "type" TEXT NOT NULL DEFAULT 'image'
);
CREATE TABLE "Tag" ("id" INTEGER PRIMARY KEY, "name" TEXT NOT NULL);
CREATE TABLE "TagsOnModels" ("modelId" INTEGER NOT NULL, "tagId" INTEGER NOT NULL);
CREATE TABLE "ModActivity" (
  "id" SERIAL PRIMARY KEY, "userId" INTEGER, "activity" TEXT NOT NULL, "entityType" TEXT,
  "entityId" INTEGER, "createdAt" TIMESTAMPTZ NOT NULL
);
CREATE TABLE "EntityModeration" (
  "id" SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending', "result" JSONB,
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
  db = await PGlite.create();
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
    ['none', [4, 6]],
  ] as const)('%s', async (source, expected) => {
    expect(await ids({ source })).toEqual(expected);
  });
});

describe('text-scan real-person flag with no snapshot', () => {
  it('reads as a text-scan source in the row, the filter and the counts', async () => {
    const { items } = await getMinorFlagAppealsForReview({ limit: 50 });
    expect(items.find((i) => i.modelId === 7)?.flagSource).toBe('text-scan');
    expect(await ids({ source: 'none' })).not.toContain(7);
  });
});

describe('flag filter', () => {
  it.each([
    ['all', [1, 2, 3, 4, 5, 6, 7]],
    ['minor', [1, 2, 6]],
    ['poi', [2, 3, 7]],
    ['unflagged', [4, 5]],
  ] as const)('%s', async (flag, expected) => {
    expect(await ids({ flag })).toEqual(expected);
  });

  it('combines with the source filter', async () => {
    expect(await ids({ source: 'moderator', flag: 'unflagged' })).toEqual([5]);
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
      await getMinorFlagAppealsForReview({ limit: 50, search: { username: 'OWNER' } }).then((r) =>
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
});

describe('facet groups', () => {
  it('yields counts that match what each filter returns', async () => {
    const groups = await getMinorFlagAppealGroups({});
    const f = appealFacets(groups, DEFAULT_APPEAL_FILTERS);
    expect(f.source).toEqual({ all: 7, 'text-scan': 2, hash: 1, moderator: 2, none: 2 });
    expect(f.flag).toEqual({ all: 7, minor: 3, poi: 3, unflagged: 2 });
  });

  it('honours the search', async () => {
    const f = appealFacets(
      await getMinorFlagAppealGroups({ search: { username: 'owner' } }),
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

  it('serves up to four owner-posted published images, in version then post then image order', async () => {
    const row = await rowFor(1);
    expect(row.coverImages.map((i) => i.url)).toEqual(['u-a', 'u-b', 'u-c', 'u-d']);
    expect(row.coverImages[1]).toEqual({ id: 2, url: 'u-b' });
    expect((await rowFor(2)).coverImages).toEqual([]);
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
