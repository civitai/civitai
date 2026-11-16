import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { redisMock } from '~/__tests__/mocks/redis.mock';

/**
 * Walks the model feed's Newest and Oldest sorts page by page against a real Postgres (PGlite).
 *
 * The cursor is `CONCAT(mm."lastVersionAt", '|', id)`; Postgres drops trailing fractional zeros,
 * so the parser must read `.25` as 250 ms. All rows share one second so a misread lands among
 * them.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

redisMock.redis.packed.get.mockImplementation(async () => null);
redisMock.redis.packed.set.mockImplementation(async () => undefined);

const { db } = vi.hoisted(() => ({ db: { pg: undefined as PGlite | undefined } }));

// A real `createPool`, so `getModelsRaw`'s Prisma.Sql goes through the production
// `cancellableQuery` and its parameter formatting (`formatSqlParam`: a Date is sent as its ISO
// string) before PGlite parses it. Only the connection is swapped: the pool never opens a socket,
// and its one connection hands the formatted text and params to PGlite.
vi.mock('~/server/db/pgDb', async () => {
  const { createPool } = await import('@civitai/db/db-helpers');
  const pool = createPool({ connectionString: 'postgresql://u:p@localhost:5432/test', ssl: false });
  pool.connect = (async () => ({
    processID: 1,
    query: (text: string, params?: unknown[]) => db.pg!.query(text, params),
    release: () => undefined,
  })) as never;
  return { pgDbRead: pool, pgDbWrite: pool, pgDbReadLong: pool };
});

vi.mock('~/server/services/image.service', () => ({
  getImagesForModelVersion: vi.fn(),
  getImagesForModelVersionCache: vi.fn(),
  queueImageSearchIndexUpdate: vi.fn(),
}));
vi.mock('~/server/flipt/client', () => ({ isFlipt: vi.fn().mockResolvedValue(false) }));
vi.mock('~/server/services/blocked-browsing-tags.service', () => ({
  enforceBlockedBrowsingTagsForModels: vi.fn().mockResolvedValue({ emptyResult: false }),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof Caches>()),
  dataForModelsCache: {
    fetch: vi.fn(async (ids: number[]) =>
      Object.fromEntries(
        ids.map((id) => [
          String(id),
          {
            versions: [
              {
                id: id * 10,
                status: 'Published',
                nsfwLevel: 1,
                baseModel: 'SDXL 1.0',
                availability: 'Public',
              },
            ],
            tags: [],
          },
        ])
      )
    ),
  },
}));

const { getModelsRaw } = await import('~/server/services/model.service');

// [modelId, lastVersionAt]. The comment is how Postgres renders the time inside the cursor.
const MODELS: [number, string][] = [
  [1, '2026-06-12 10:00:00.300'], // .3
  [8, '2026-06-12 10:00:00.250'], // .25, tied with 2
  [2, '2026-06-12 10:00:00.250'], // .25
  [3, '2026-06-12 10:00:00.123'], // .123
  [4, '2026-06-12 10:00:00.100'], // .1
  [5, '2026-06-12 10:00:00.070'], // .07
  [6, '2026-06-12 10:00:00.020'], // .02
  [7, '2026-06-12 10:00:00.000'], // no fraction
];
const NEWEST_ORDER = [1, 8, 2, 3, 4, 5, 6, 7];
const OLDEST_ORDER = [7, 6, 5, 4, 3, 2, 8, 1];

beforeAll(async () => {
  db.pg = new PGlite();
  await db.pg.exec(`
    CREATE TYPE "ModelStatus" AS ENUM ('Draft', 'Training', 'Published', 'Scheduled', 'Unpublished', 'UnpublishedViolation', 'GatherInterest', 'Deleted');
    CREATE TYPE "ModelModifier" AS ENUM ('Archived', 'TakenDown');
    CREATE TYPE "Availability" AS ENUM ('Public', 'Unsearchable', 'Private', 'EarlyAccess');
    CREATE TABLE "Model" (
      id int PRIMARY KEY,
      name text NOT NULL,
      "sfwName" text,
      "coverImageId" int,
      "sfwCoverImageId" int,
      type text NOT NULL,
      "sfwOnly" boolean NOT NULL DEFAULT false,
      nsfw boolean NOT NULL DEFAULT false,
      "createdAt" timestamp(3) NOT NULL,
      "publishedAt" timestamp(3),
      locked boolean NOT NULL DEFAULT false,
      meta jsonb
    );
    CREATE TABLE "ModelMetric" (
      "modelId" int PRIMARY KEY,
      "userId" int NOT NULL,
      status "ModelStatus" NOT NULL,
      mode "ModelModifier",
      availability "Availability" NOT NULL,
      "nsfwLevel" int NOT NULL,
      minor boolean NOT NULL DEFAULT false,
      poi boolean NOT NULL DEFAULT false,
      "lastVersionAt" timestamp(3),
      "downloadCount" int NOT NULL DEFAULT 0,
      "thumbsUpCount" int NOT NULL DEFAULT 0,
      "thumbsDownCount" int NOT NULL DEFAULT 0,
      "commentCount" int NOT NULL DEFAULT 0,
      "collectedCount" int NOT NULL DEFAULT 0,
      "tippedAmountCount" int NOT NULL DEFAULT 0
    );
  `);
  for (const [id, at] of MODELS) {
    await db.pg.query(
      `INSERT INTO "Model" (id, name, type, "createdAt", "publishedAt")
       VALUES ($1, $2, 'Checkpoint', $3, $3)`,
      [id, `model ${id}`, at]
    );
    await db.pg.query(
      `INSERT INTO "ModelMetric" ("modelId", "userId", status, availability, "nsfwLevel", "lastVersionAt")
       VALUES ($1, 1, 'Published', 'Public', 1, $2)`,
      [id, at]
    );
  }
});

afterAll(async () => {
  await db.pg?.close();
});

/** Follows nextCursor to the end, or until `maxPages` — a repeating walk never ends on its own. */
async function walk(sort: 'Newest' | 'Oldest', take: number, maxPages = 20) {
  const seen: number[] = [];
  const cursors: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const result = await getModelsRaw({
      input: { browsingLevel: 1, take, sort, period: 'AllTime', cursor } as never,
    });
    seen.push(...result.items.map((m) => m.id));
    if (!result.nextCursor) break;
    cursor = String(result.nextCursor);
    cursors.push(cursor);
  }
  return { seen, cursors };
}

describe('model feed pagination across a short-fraction cursor', () => {
  it('Postgres renders the cursor timestamp without trailing zeros (precondition)', async () => {
    // The input every other case depends on. If this rendering ever changes, the walks below
    // stop exercising short fractions and must be re-pointed.
    const { cursors } = await walk('Newest', 2, 1);
    expect(cursors).toEqual(['2026-06-12 10:00:00.25|2']);
  });

  it('CONTROL: a single page holding every row needs no cursor', async () => {
    const { seen, cursors } = await walk('Newest', 20);
    expect(cursors).toEqual([]);
    expect(seen).toEqual(NEWEST_ORDER);
  });

  it('Newest: a walk two rows at a time returns every model once, in order (no skips)', async () => {
    const { seen, cursors } = await walk('Newest', 2);
    expect(cursors).toEqual([
      '2026-06-12 10:00:00.25|2',
      '2026-06-12 10:00:00.1|4',
      '2026-06-12 10:00:00.02|6',
    ]);
    expect(seen).toEqual(NEWEST_ORDER);
  });

  it('Oldest: a walk two rows at a time returns every model once, in order (no repeats)', async () => {
    const { seen, cursors } = await walk('Oldest', 2);
    expect(cursors).toEqual([
      '2026-06-12 10:00:00.07|5',
      '2026-06-12 10:00:00.123|3',
      '2026-06-12 10:00:00.25|8',
    ]);
    expect(seen).toEqual(OLDEST_ORDER);
  });

  it('Newest: one row per page crosses every fraction length as a cursor', async () => {
    const { seen } = await walk('Newest', 1);
    expect(seen).toEqual(NEWEST_ORDER);
  });

  it('Oldest: one row per page crosses every fraction length as a cursor', async () => {
    const { seen } = await walk('Oldest', 1);
    expect(seen).toEqual(OLDEST_ORDER);
  });
});
