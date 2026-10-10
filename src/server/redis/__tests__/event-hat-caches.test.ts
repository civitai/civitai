import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * The two caches the hat popover reads instead of Postgres: the decoration each piece of content
 * wears (with its wearer), and whether the content is public. Their lookups are the only reads left,
 * one per miss; these pin what each one asks.
 */

const { eventDecorationEntityCaches, publicContentCaches, cosmeticCache } = await import(
  '~/server/redis/caches'
);

const sql = (call: unknown[]) => (call[0] as string[]).join('?').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  dbMock.dbRead.$queryRaw.mockReset();
  dbMock.dbWrite.$queryRaw.mockReset();
});

describe('publicContentCaches', () => {
  it('reads an image as public only once its post is published and it passed review', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([{ id: 5 }]);
    expect(await publicContentCaches.Image!.fetch([5, 6])).toEqual({ 5: { id: 5 } });
    const [call] = dbMock.dbRead.$queryRaw.mock.calls;
    expect(sql(call)).toBe(
      `SELECT i.id FROM "Image" i JOIN "Post" p ON p.id = i."postId" WHERE i.id IN (?) ` +
        `AND p."publishedAt" <= now() AND p.availability <> 'Private' AND NOT p."tosViolation" ` +
        `AND i.ingestion = 'Scanned' AND i."needsReview" IS NULL AND NOT i."tosViolation"`
    );
    expect(dbMock.dbWrite.$queryRaw).not.toHaveBeenCalled();
  });

  it('reads a model as public once published, and an article once published and scanned', async () => {
    dbMock.dbRead.$queryRaw.mockResolvedValue([]);
    expect(await publicContentCaches.Model!.fetch([7])).toEqual({});
    expect(await publicContentCaches.Article!.fetch([8])).toEqual({});
    const [model, article] = dbMock.dbRead.$queryRaw.mock.calls;
    expect(sql(model)).toBe(
      `SELECT m.id FROM "Model" m WHERE m.id IN (?) AND m.status = 'Published' ` +
        `AND m.availability <> 'Private' AND NOT m."tosViolation"`
    );
    expect(sql(article)).toBe(
      `SELECT a.id FROM "Article" a WHERE a.id IN (?) AND a.status = 'Published' ` +
        `AND a.ingestion = 'Scanned' AND a.availability <> 'Private' AND NOT a."tosViolation"`
    );
  });

  it('has no entry for content that never shows a hat popover', () => {
    expect(Object.keys(publicContentCaches).sort()).toEqual(['Article', 'Image', 'Model']);
  });
});

describe('eventDecorationEntityCaches', () => {
  it("caches the wearer's id with the decoration", async () => {
    dbMock.dbWrite.$queryRaw.mockResolvedValue([{ cosmeticId: 31, equippedToId: 5, userId: 9 }]);
    const fetch = cosmeticCache.fetch;
    cosmeticCache.fetch = (async () => ({
      31: {
        id: 31,
        name: 'Party Cap - Blue',
        type: 'ContentDecoration',
        source: 'Purchase',
        data: { type: 'hat', event: 'birthday2026', url: 'u', team: 'Blue' },
      },
    })) as never;
    try {
      const worn = await eventDecorationEntityCaches.Image.fetch([5]);
      expect(worn[5]).toMatchObject({ id: 31, userId: 9, equippedToId: 5 });
    } finally {
      cosmeticCache.fetch = fetch;
    }
    expect(sql(dbMock.dbWrite.$queryRaw.mock.calls[0])).toMatch(
      /^SELECT uc."cosmeticId", uc."equippedToId", uc."userId" FROM "UserCosmetic" uc/
    );
  });
});
