import { PGlite } from '@electric-sql/pglite';
import { Prisma } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

const getDocument = vi.hoisted(() =>
  vi.fn(async (_id: number): Promise<{ profilePicture?: { id?: number } | null }> => ({}))
);
vi.mock('~/server/meilisearch/client', () => ({
  searchClient: { index: () => ({ getDocument }) },
}));

const { countSearchDocsStillCarrying, markedPictureUsers, refreshMarkedPictureUsers } =
  await import('~/server/services/refresh-marked-profile-pictures');

let pg: PGlite;
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TYPE "ImageIngestionStatus" AS ENUM ('Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'Rescan');
    CREATE TABLE "Image" (
      id int PRIMARY KEY, ingestion "ImageIngestionStatus" NOT NULL, "nsfwLevel" int NOT NULL,
      "blockedFor" text
    );
    CREATE TABLE "User" (id int PRIMARY KEY, "profilePictureId" int, "deletedAt" timestamp);
    INSERT INTO "Image" VALUES
      (11, 'Blocked', 1, NULL), (12, 'Scanned', 32, NULL), (13, 'Scanned', 1, 'tos'),
      (14, 'Scanned', 1, NULL), (15, 'Scanned', 1, 'tos');
    INSERT INTO "User" VALUES
      (1, 11, NULL), (2, 12, NULL), (3, 13, NULL), (4, 14, NULL), (5, 15, now()), (6, NULL, NULL);
  `);
  dbMock.dbRead.$queryRaw.mockImplementation(((
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = Prisma.sql(strings, ...(values as never[]));
    return pg.query(sql.text, sql.values as unknown[]).then((r) => r.rows);
  }) as never);
});
afterAll(() => pg.close());
beforeEach(() => {
  getDocument.mockReset();
});

describe('the one-off refresh of profile pictures that follow visibility rules', () => {
  it('selects live users whose profile picture carries any block marker', async () => {
    expect(await markedPictureUsers()).toEqual([
      { userId: 1, pictureId: 11 },
      { userId: 2, pictureId: 12 },
      { userId: 3, pictureId: 13 },
    ]);
  });

  it('refreshes and queues in chunks of 100', async () => {
    const refresh = vi.fn(async (_ids: number[]) => undefined);
    const queue = vi.fn(async (_items: { id: number; action: string }[]) => undefined);
    const ids = Array.from({ length: 250 }, (_, i) => i + 1);
    expect(await refreshMarkedPictureUsers(ids, { refresh, queue })).toEqual({ chunks: 3 });
    expect(refresh.mock.calls.map(([chunk]) => chunk.length)).toEqual([100, 100, 50]);
    expect(queue.mock.calls[2][0]).toEqual(ids.slice(200).map((id) => ({ id, action: 'Update' })));
  });

  it('counts documents still carrying the picture, and a missing document as not indexed', async () => {
    getDocument.mockImplementation(async (id: number) => {
      if (id === 1) return { profilePicture: { id: 11 } };
      if (id === 2) return { profilePicture: { id: 99 } };
      if (id === 3) return { profilePicture: null };
      throw Object.assign(new Error('not found'), { code: 'document_not_found', httpStatus: 404 });
    });
    expect(
      await countSearchDocsStillCarrying([
        { userId: 1, pictureId: 11 },
        { userId: 2, pictureId: 12 },
        { userId: 3, pictureId: 13 },
        { userId: 4, pictureId: 14 },
      ])
    ).toEqual({ stillCarrying: 1, notIndexed: 1 });
  });

  it('fails on any other search error', async () => {
    getDocument.mockRejectedValue(Object.assign(new Error('boom'), { httpStatus: 500 }));
    await expect(countSearchDocsStillCarrying([{ userId: 1, pictureId: 11 }])).rejects.toThrow(
      'boom'
    );
  });
});
