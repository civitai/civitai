import type { PGlite } from '@electric-sql/pglite';
import { Kysely } from 'kysely';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { freshPglite } from '../../../test/pglite';
import { pgliteDialect } from './abuse-detection-pglite.harness';

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
vi.mock('../search-index', () => ({ syncSearchIndexBulk: vi.fn(async () => undefined) }));
vi.mock('../axiom', () => ({ logAxiomError: vi.fn(async () => undefined) }));

const { queueArticlesForCoverImages } = await import('../article-cover-reindex');
const { syncSearchIndexBulk } = await import('../search-index');
const { logAxiomError } = await import('../axiom');

// Image 100 is article 1's cover and 101 its banner; 200 is article 2's banner; 300 is neither.
const SCHEMA = `
CREATE TABLE "Article" ("id" INTEGER PRIMARY KEY, "coverId" INTEGER UNIQUE, "bannerId" INTEGER UNIQUE);
INSERT INTO "Article" VALUES (1, 100, 101), (2, NULL, 200), (3, 500, NULL);
CREATE TABLE "ComicProject" ("id" INTEGER PRIMARY KEY, "coverImageId" INTEGER);
INSERT INTO "ComicProject" VALUES (7, 200), (8, 600);
`;

let db: PGlite;

beforeEach(async () => {
  vi.mocked(syncSearchIndexBulk).mockReset().mockResolvedValue(undefined);
  vi.mocked(logAxiomError).mockClear();
  db = await freshPglite();
  await db.exec(SCHEMA);
  dbHandle.current = new Kysely({ dialect: pgliteDialect(db) });
});

afterEach(async () => {
  dbHandle.current = null;
  await db.close();
});

const queued = () =>
  vi
    .mocked(syncSearchIndexBulk)
    .mock.calls.flatMap(([batch]) =>
      batch.entityIds.map((id) => [batch.entityType, id, batch.action])
    );

describe('spoke queueArticlesForCoverImages', () => {
  it('queues an article Update for each article whose cover or banner is one of the images', async () => {
    await queueArticlesForCoverImages([100, 200]);
    expect(queued().sort()).toEqual([
      ['article', 1, 'update'],
      ['article', 2, 'update'],
      ['comic', 7, 'update'],
    ]);
  });

  it('queues a comic Update for a comic whose cover is one of the images', async () => {
    await queueArticlesForCoverImages([600]);
    expect(queued()).toEqual([['comic', 8, 'update']]);
  });

  // As the real call behaves when the main app refuses it: only strict mode throws.
  const refuse = (entityType: string) =>
    vi.mocked(syncSearchIndexBulk).mockImplementation(async (batch, options) => {
      if (batch.entityType === entityType && options?.strict) throw new Error('sync failed: 503');
    });

  it('🔴 logs a refused requeue with the image ids', async () => {
    refuse('article');
    await queueArticlesForCoverImages([100]);
    expect(logAxiomError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ entityType: 'article', imageIds: [100] })
    );
  });

  it('still sends the comic requeue when the article one is refused', async () => {
    refuse('article');
    await queueArticlesForCoverImages([200]);
    expect(queued()).toContainEqual(['comic', 7, 'update']);
  });

  it('queues nothing for an image that is no cover or banner (control)', async () => {
    await queueArticlesForCoverImages([300]);
    expect(queued()).toEqual([]);
  });
});
