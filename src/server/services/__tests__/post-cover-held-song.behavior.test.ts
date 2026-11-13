import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/** The post feed's images, run as SQL over seeded rows: a song whose lyrics are held is not a cover. */

vi.mock('../../../../event-engine-common/services/metrics', () => ({
  MetricService: class {
    fetch = vi.fn();
  },
}));
vi.mock('../../../../event-engine-common/feeds', () => ({ ImagesFeed: class {} }));
vi.mock('../../../../event-engine-common/services/cache', () => ({ CacheService: class {} }));
vi.mock('~/server/clickhouse/client', () => ({ clickhouse: {} }));

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
    CREATE TYPE "MediaType" AS ENUM ('image', 'video', 'audio');
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, "postId" int, "userId" int, name text, url text, "nsfwLevel" int,
      width int, height int, hash text, type "MediaType" NOT NULL, metadata jsonb, meta jsonb,
      minor boolean, poi boolean, ingestion "ImageIngestionStatus" NOT NULL, "needsReview" text,
      "acceptableMinor" boolean NOT NULL DEFAULT false, "blockedFor" text,
      "modelRestricted" boolean NOT NULL DEFAULT false, index int, "nsfwLevelLocked" boolean NOT NULL DEFAULT false,
      "scanJobs" jsonb
    );
    CREATE TABLE "TextScanHold" (
      id serial PRIMARY KEY, "entityType" text, "entityId" int, label text, status text
    );
    INSERT INTO "Image" (id, "postId", "userId", "nsfwLevel", type, ingestion, index) VALUES
      (1, ${POST}, ${OWNER}, 1, 'audio', 'Scanned', 1),
      (2, ${POST}, ${OWNER}, 1, 'audio', 'Scanned', 2),
      (3, ${POST}, ${OWNER}, 1, 'audio', 'Scanned', 3),
      (4, ${POST}, ${OWNER}, 1, 'image', 'Scanned', 4);
    INSERT INTO "TextScanHold" ("entityType", "entityId", label, status) VALUES
      ('TrackLyrics', 1, 'csam', 'Pending'),
      ('TrackLyrics', 2, 'csam', 'Confirmed'),
      ('TrackLyrics', 3, 'csam', 'Dismissed');
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
  ])('leave out a song whose lyrics are held or confirmed for csam, %s', async (_label, args) => {
    expect(await visible(args)).toEqual([3, 4]);
  });
});
