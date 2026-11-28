import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

/**
 * The post feed's images, run as SQL over seeded rows: a song held for csam review (its lyrics or
 * cover held, PR #10162) is not a cover for anyone else.
 */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));
// Flipt answers the `music` flag: on for every viewer here.
vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  ensureFliptInitialized: async () => undefined,
  isFliptSync: (key: string) => (key === 'music' ? true : null),
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { getImagesForPosts } from '~/server/services/image.service';
import type { SessionUser } from '~/types/session';

const POST = 10;
const OWNER = 1;
const STOP = new Error('query captured');

let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "userId" int, name text, url text, "nsfwLevel" int,
      width int, height int, hash text, type text NOT NULL, metadata jsonb, meta jsonb,
      minor boolean, poi boolean, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "blockedFor" text,
      "modelRestricted" boolean NOT NULL DEFAULT false, index int, "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb
    );
    INSERT INTO "Image" (id, "postId", "userId", "nsfwLevel", type, ingestion, index, "needsReview") VALUES
      (1, ${POST}, ${OWNER}, 1, 'audio', 'Scanned', 1, 'csam'),
      (3, ${POST}, ${OWNER}, 1, 'audio', 'Scanned', 3, NULL),
      (4, ${POST}, ${OWNER}, 1, 'image', 'Scanned', 4, NULL);
  `);
});
afterAll(() => db.close());

beforeEach(() => {
  vi.clearAllMocks();
});

/** Runs the reader up to its query, then runs that query over the seeded rows. */
async function visible(args: { browsingLevel?: number; user?: SessionUser }) {
  let captured: Prisma.Sql | undefined;
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (first: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
      captured = Array.isArray(first)
        ? Prisma.sql(first as TemplateStringsArray, ...values)
        : (first as Prisma.Sql);
      throw STOP;
    }
  );
  await expect(getImagesForPosts({ postIds: [POST], ...args })).rejects.toBe(STOP);
  if (!captured) throw new Error('reader never queried');
  const rows = await db.query<{ id: number }>(captured.text, captured.values as unknown[]);
  return rows.rows.map((r) => r.id);
}

describe('the images of a post in the feed', () => {
  it.each([
    ['within a browsing level', { browsingLevel: 1 }],
    ['with no browsing level', {}],
    ['for another signed-in user', { browsingLevel: 1, user: { id: 99 } as SessionUser }],
  ])('leave out a song held for csam review, %s', async (_label, args) => {
    expect(await visible(args)).toEqual([3, 4]);
  });
});
