import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RedisCaches from '~/server/redis/caches';

// The post feed's images (`getImagesForPosts`, outside the pending view) carry only reviewed
// images, as every other image feed does.

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
}));

const { dbMock } = await import('~/__tests__/mocks/db.mock');
const { getImagesForPosts } = await import('~/server/services/image.service');

const OWNER = 1;
const VISITOR = 2;
const PG = 1;

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan', 'PendingManualAssignment');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int NOT NULL, "userId" int NOT NULL, name text, url text NOT NULL,
      "nsfwLevel" int NOT NULL DEFAULT 1, width int, height int, hash text, type text DEFAULT 'image',
      metadata jsonb DEFAULT '{}', meta jsonb, minor boolean DEFAULT false, poi boolean DEFAULT false,
      "needsReview" text, "acceptableMinor" boolean DEFAULT false, "blockedFor" text,
      "modelRestricted" boolean DEFAULT false, index int DEFAULT 0,
      ingestion "ImageIngestionStatus" NOT NULL DEFAULT 'Scanned',
      "nsfwLevelLocked" boolean NOT NULL DEFAULT false, "scanJobs" jsonb
    );
    INSERT INTO "Image" (id, "postId", "userId", url, ingestion, "nsfwLevelLocked") VALUES
      (1, 10, ${OWNER}, 'scanned', 'Scanned', false),
      (2, 10, ${OWNER}, 'pending', 'Pending', false),
      (3, 10, ${OWNER}, 'error', 'Error', false),
      (4, 10, ${OWNER}, 'pending-mod-rated', 'Pending', true);
  `);
});
afterAll(() => pg.close());

beforeEach(() => {
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = Prisma.sql(strings, ...(values as never[]));
      return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
    }
  );
});

const urls = async (args: Parameters<typeof getImagesForPosts>[0]) =>
  (await getImagesForPosts(args)).map((i) => i.url).sort();

describe('getImagesForPosts outside the pending view', () => {
  it.each([
    ['signed out', undefined],
    ['signed in', { id: VISITOR }],
    ['the owner', { id: OWNER }],
  ])('serves only reviewed images to a viewer %s', async (_, user) => {
    expect(await urls({ postIds: [10], browsingLevel: PG, user: user as never })).toEqual([
      'pending-mod-rated',
      'scanned',
    ]);
  });

  it('serves a moderator every image in the pending view', async () => {
    expect(
      await urls({
        postIds: [10],
        browsingLevel: PG,
        pending: true,
        user: { id: 9, isModerator: true } as never,
      })
    ).toEqual(['error', 'pending', 'pending-mod-rated', 'scanned']);
  });
});
