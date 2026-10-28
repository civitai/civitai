import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Caches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

// The guard lives in the UPDATE's WHERE clause, so these run the service's real SQL on an in-process
// Postgres: a mocked client could not tell a guarded write from an unguarded one.

vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof Caches>();
  return {
    ...actual,
    refreshThumbnailCache: vi.fn(() => Promise.resolve()),
    imageMetadataCache: { ...actual.imageMetadataCache, refresh: vi.fn(() => Promise.resolve()) },
  };
});

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));

vi.mock('~/env/server', () => ({
  env: new Proxy({ LOGGING: [] as string[] } as Record<string, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop as string];
      if (typeof prop === 'string' && (prop.endsWith('_URL') || prop.endsWith('_ENDPOINT')))
        return 'https://test:test@localhost:5432/test';
      if (
        typeof prop === 'string' &&
        /(_CONCURRENCY|_LIMIT|_MS|_PORT|_TIMEOUT|_MAX|_SIZE|_COUNT)$/.test(prop)
      )
        return 1;
      return undefined;
    },
  }),
}));

vi.mock('~/server/search-index', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  imagesSearchIndex: { queueUpdate: vi.fn() },
  imagesMetricsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/games/new-order/utils', async (importOriginal) => {
  const reset = { reset: vi.fn(() => Promise.resolve()) };
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    poolCounters: {
      Knight: { a: [reset], b: [reset] },
      Templar: { a: [reset], b: [reset] },
    },
  };
});

const { setImageNsfwLevelFromKnights } = await import('../image.service');
const { refreshThumbnailCache } = await import('~/server/redis/caches');

let pg: PGlite;

beforeAll(async () => {
  pg = await PGlite.create();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      "id" integer PRIMARY KEY,
      "postId" integer,
      "metadata" jsonb NOT NULL DEFAULT '{}',
      "nsfwLevel" integer NOT NULL DEFAULT 0,
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "ingestion" "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "blockedFor" text,
      "updatedAt" timestamp NOT NULL DEFAULT '2020-01-01'
    );
  `);
});
afterAll(async () => {
  await pg.close();
});

type Row = {
  nsfwLevel: number;
  nsfwLevelLocked: boolean;
  metadata: Record<string, unknown>;
  ingestion: string;
  blockedFor: string | null;
};
const IMAGE = 7301;
const PLAYER = 4242;

async function seed(o: Partial<Row> = {}) {
  const row: Row = {
    nsfwLevel: 4,
    nsfwLevelLocked: false,
    metadata: {},
    ingestion: 'Scanned',
    blockedFor: null,
    ...o,
  };
  await pg.query(`DELETE FROM "Image"`);
  await pg.query(
    `INSERT INTO "Image" ("id","postId","metadata","nsfwLevel","nsfwLevelLocked","ingestion","blockedFor")
     VALUES ($1, 55, $2, $3, $4, $5::"ImageIngestionStatus", $6)`,
    [
      IMAGE,
      JSON.stringify(row.metadata),
      row.nsfwLevel,
      row.nsfwLevelLocked,
      row.ingestion,
      row.blockedFor,
    ]
  );
}
const stored = async () =>
  (await pg.query<Row>(`SELECT * FROM "Image" WHERE id=$1`, [IMAGE])).rows[0];

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.$queryRaw.mockImplementation((async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const query = Prisma.sql(strings, ...values);
    return (await pg.query(query.text, query.values as unknown[])).rows;
  }) as never);
  dbMock.dbWrite.image.findUnique.mockImplementation(
    (async () =>
      (await pg.query(`SELECT * FROM "Image" WHERE id=$1`, [IMAGE])).rows[0] ?? null) as never
  );
});

const write = (nsfwLevel = 8) =>
  setImageNsfwLevelFromKnights({ id: IMAGE, nsfwLevel, userId: PLAYER });

describe('setImageNsfwLevelFromKnights', () => {
  it('rates and locks an unlocked image, and runs the side effects once', async () => {
    await seed();
    expect(await write(8)).toEqual({ applied: true });

    expect(await stored()).toMatchObject({
      nsfwLevel: 8,
      nsfwLevelLocked: true,
      metadata: { nsfwLevelReason: 'Knights Vote' },
    });
    expect(refreshThumbnailCache).toHaveBeenCalledTimes(1);
    expect(dbMock.dbWrite.imageRatingRequest.updateMany).toHaveBeenCalledWith({
      where: { imageId: IMAGE, status: 'Pending' },
      data: { status: 'Actioned' },
    });
  });

  it('keeps the rest of the image metadata', async () => {
    await seed({ metadata: { prompt: 'kept' } });
    await write();
    expect((await stored()).metadata).toEqual({ prompt: 'kept', nsfwLevelReason: 'Knights Vote' });
  });

  it('may re-rate an image an earlier Knights vote locked', async () => {
    await seed({
      nsfwLevelLocked: true,
      nsfwLevel: 2,
      metadata: { nsfwLevelReason: 'Knights Vote' },
    });
    expect(await write(8)).toEqual({ applied: true });
    expect((await stored()).nsfwLevel).toBe(8);
  });

  it('leaves an image a moderator locked alone and reports the moderator level', async () => {
    await seed({
      nsfwLevelLocked: true,
      nsfwLevel: 2,
      metadata: { nsfwLevelReason: 'Moderator review' },
    });
    expect(await write(8)).toEqual({ applied: false, reason: 'locked', currentLevel: 2 });
    expect(await stored()).toMatchObject({ nsfwLevel: 2, nsfwLevelLocked: true });
    expect(refreshThumbnailCache).not.toHaveBeenCalled();
    expect(dbMock.dbWrite.imageRatingRequest.updateMany).not.toHaveBeenCalled();
  });

  it('leaves a moderator-locked image with no recorded reason alone', async () => {
    await seed({ nsfwLevelLocked: true, nsfwLevel: 2 });
    expect(await write(8)).toMatchObject({ applied: false, reason: 'locked' });
    expect((await stored()).nsfwLevel).toBe(2);
  });

  it.each([
    ['a Blocked level', { nsfwLevel: 32 }],
    ['a block reason', { blockedFor: 'tos' }],
    ['Blocked ingestion', { ingestion: 'Blocked' }],
  ])('refuses an image with %s, even when unlocked', async (_label, marker) => {
    await seed(marker);
    expect(await write(8)).toMatchObject({ applied: false, reason: 'blocked' });
    expect(await stored()).toMatchObject({ nsfwLevelLocked: false });
    expect((await stored()).nsfwLevel).toBe(marker.nsfwLevel ?? 4);
    expect(refreshThumbnailCache).not.toHaveBeenCalled();
  });

  it('refuses an image that is not there', async () => {
    await pg.query(`DELETE FROM "Image"`);
    expect(await write()).toEqual({ applied: false, reason: 'missing', currentLevel: null });
    expect(refreshThumbnailCache).not.toHaveBeenCalled();
  });
});
