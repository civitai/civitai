import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { CrucibleStatus } from '~/shared/utils/prisma/enums';

/**
 * A crucible claims as many entries as its grid lists to the person looking. The count and the list
 * are separate queries over one fragment, so this runs both as written against real Postgres, on
 * the same rows: a mocked database would agree with whatever the SQL said.
 */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const CRUCIBLE = 154;
const HOST = 1;
const VIEWER = 7;

let pg: PGlite;

const { getCrucibleEntries } = await import('~/server/services/crucible.service');

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Blocked', 'Error', 'NotFound');
    CREATE TABLE "Post" (id int PRIMARY KEY, "publishedAt" timestamp(3));
    CREATE TABLE "Image" (
      id int PRIMARY KEY,
      ingestion "ImageIngestionStatus" NOT NULL,
      "needsReview" text,
      "tosViolation" boolean NOT NULL DEFAULT false,
      "postId" int,
      "nsfwLevel" int NOT NULL DEFAULT 1
    );
    CREATE TABLE "CrucibleEntry" (
      id int PRIMARY KEY,
      "crucibleId" int NOT NULL,
      "userId" int NOT NULL,
      "imageId" int,
      score int NOT NULL DEFAULT 1500,
      position int,
      "createdAt" timestamp(3) NOT NULL DEFAULT now()
    );
  `);
});

// Entry id -> what became of its image.
beforeEach(async () => {
  await pg.exec(`
    TRUNCATE "Post", "Image", "CrucibleEntry";
    INSERT INTO "Post" (id, "publishedAt") VALUES (1, now()), (2, NULL);
    INSERT INTO "Image" (id, ingestion, "needsReview", "tosViolation", "postId") VALUES
      (11, 'Scanned', NULL, false, 1),
      (12, 'Scanned', NULL, false, 1),
      (13, 'Pending', NULL, false, 1),
      (14, 'Scanned', NULL, true, 1),
      (15, 'Scanned', 'poi', false, 1),
      (16, 'Scanned', NULL, false, 2),
      (17, 'Scanned', NULL, true, 1);
    INSERT INTO "CrucibleEntry" (id, "crucibleId", "userId", "imageId") VALUES
      (1, ${CRUCIBLE}, 100, 11),    -- listed
      (2, ${CRUCIBLE}, 101, 12),    -- listed
      (3, ${CRUCIBLE}, 102, 13),    -- not scanned yet
      (4, ${CRUCIBLE}, 103, 14),    -- flagged as a ToS violation
      (5, ${CRUCIBLE}, 104, NULL),  -- its image was deleted
      (6, ${CRUCIBLE}, ${VIEWER}, 17), -- the viewer's own, hidden from everyone else but them
      (7, ${CRUCIBLE}, ${VIEWER}, NULL), -- the viewer's own, image deleted
      (8, ${CRUCIBLE}, 105, 15),    -- held for review
      (9, ${CRUCIBLE}, 106, 16),    -- its post is unpublished
      (99, 999, 100, 11);           -- another crucible's
  `);
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const flat = Prisma.sql(strings, ...(values as never[]));
    return (await pg.query(flat.text, flat.values as unknown[])).rows;
  }) as never;
  dbMock.dbRead.$queryRaw.mockImplementation(sql);
  dbMock.dbRead.crucible.findUnique.mockResolvedValue({
    status: CrucibleStatus.Active,
    userId: HOST,
    textNsfw: false,
    nsfwLevel: 1,
    ingestion: 'Scanned',
    prizePositions: [],
    image: { ingestion: 'Scanned' },
  } as never);
  // The page query returns ids; this only has to say each still has an image.
  dbMock.dbRead.crucibleEntry.findMany.mockImplementation((async ({
    where,
  }: {
    where: { id: { in: number[] } };
  }) => where.id.in.map((id) => ({ id, image: { id: id * 10 } }))) as never);
});

const entriesFor = (viewerId?: number, extra: { limit?: number; cursor?: number } = {}) =>
  getCrucibleEntries({
    crucibleId: CRUCIBLE,
    limit: extra.limit ?? 50,
    cursor: extra.cursor,
    seed: 3,
    userId: viewerId,
    browsingLevel: 1,
  });

const rawRows = async () =>
  (
    await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "CrucibleEntry" WHERE "crucibleId" = ${CRUCIBLE}`
    )
  ).rows[0].n;

describe('visible entry count', () => {
  it('counts exactly what the list returns for a signed-in viewer', async () => {
    const { items, visibleCount } = await entriesFor(VIEWER);

    // 1 and 2, plus the viewer's own entry 6 whose image everyone else cannot see. Entry 7 has no image.
    expect(items.map((x) => x.id).sort()).toEqual([1, 2, 6]);
    expect(visibleCount).toBe(items.length);
  });

  it('counts exactly what the list returns for a signed-out viewer', async () => {
    const { items, visibleCount } = await entriesFor(undefined);

    expect(items.map((x) => x.id).sort()).toEqual([1, 2]);
    expect(visibleCount).toBe(items.length);
  });

  it('is smaller than the row count, which still counts what is hidden', async () => {
    const { visibleCount } = await entriesFor(undefined);

    expect(await rawRows()).toBe(9);
    expect(visibleCount).toBeLessThan(await rawRows());
  });

  it('is the whole list on the first page and absent on a later one', async () => {
    const first = await entriesFor(VIEWER, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.visibleCount).toBe(3);

    const next = await entriesFor(VIEWER, { limit: 2, cursor: first.nextCursor });
    expect(next.visibleCount).toBeUndefined();
  });
});
