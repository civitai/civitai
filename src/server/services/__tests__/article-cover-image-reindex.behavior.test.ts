import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { pgliteRaw } from '~/server/events/__tests__/pglite-prisma';

/** Runs `queueArticlesForCoverImages`' real lookup against an in-process Postgres. */

vi.setConfig({ hookTimeout: 60_000, testTimeout: 60_000 });

const { queueUpdate } = vi.hoisted(() => ({ queueUpdate: vi.fn(async () => undefined) }));
vi.mock('~/server/search-index', () => ({ articlesSearchIndex: { queueUpdate } }));

const { queueArticlesForCoverImages } = await import('~/server/services/article-cover-reindex');

beforeAll(async () => {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE "Article" (id int PRIMARY KEY, "coverId" int UNIQUE, "bannerId" int UNIQUE);
    -- Image 100 is article 1's cover and 101 its banner; 200 is article 2's banner; 300 is in no
    -- article's cover or banner.
    INSERT INTO "Article" VALUES (1, 100, 101), (2, NULL, 200), (3, 500, NULL);
  `);
  (dbMock.dbRead.$queryRaw as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    pgliteRaw(db).queryRaw
  );
});

beforeEach(() => {
  queueUpdate.mockClear();
});

const queued = () =>
  queueUpdate.mock.calls.flatMap((call) =>
    (call as unknown as [{ id: number; action: string }[]])[0].map((x) => [x.id, x.action])
  );

describe('queueArticlesForCoverImages', () => {
  it('queues an Update for each article whose cover or banner is one of the images', async () => {
    await queueArticlesForCoverImages([100, 200]);
    expect(queued().sort()).toEqual([
      [1, 'Update'],
      [2, 'Update'],
    ]);
  });

  it('queues an article once when the images are both its cover and its banner', async () => {
    await queueArticlesForCoverImages([100, 101]);
    expect(queued()).toEqual([[1, 'Update']]);
  });

  it('queues nothing for an image that is no cover or banner (control)', async () => {
    await queueArticlesForCoverImages([300]);
    expect(queueUpdate).not.toHaveBeenCalled();
  });
});
