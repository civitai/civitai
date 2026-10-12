import type { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';

/**
 * `managesImageCollection` hands an above-cap image's media to whoever it answers true for, so its
 * SQL is pinned whole: a MANAGE contributor of the collection the post was submitted to, or of a
 * contest collection holding the image. A collection of any other mode must not count.
 */

const { queryRaw } = vi.hoisted(() => ({ queryRaw: vi.fn() }));
vi.mock('~/server/db/client', () => ({ dbRead: { $queryRaw: queryRaw } }));

const { managesImageCollection } = await import('~/server/utils/image-media-visibility');

const normalise = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ').trim();

const MANAGE = `cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]`;

describe('managesImageCollection', () => {
  it('asks only about MANAGE on the post collection or a contest collection holding the image', async () => {
    queryRaw.mockResolvedValueOnce([{ managed: true }]);
    expect(await managesImageCollection({ imageId: 1, postId: 30, userId: 42 })).toBe(true);

    const [sql] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(normalise(sql)).toBe(
      [
        'SELECT EXISTS (',
        'SELECT 1 FROM "Post" p',
        'JOIN "CollectionContributor" cc ON cc."collectionId" = p."collectionId"',
        `WHERE p.id = ? AND cc."userId" = ? AND ${MANAGE}`,
        ') OR EXISTS (',
        'SELECT 1 FROM "CollectionItem" ci',
        'JOIN "Collection" c ON c.id = ci."collectionId"',
        'JOIN "CollectionContributor" cc ON cc."collectionId" = ci."collectionId"',
        `WHERE ci."imageId" = ? AND c.mode = 'Contest' AND cc."userId" = ? AND ${MANAGE}`,
        ') AS managed',
      ].join(' ')
    );
    expect(sql.values).toEqual([30, 42, 1, 42]);
  });

  it('answers false when the query finds nothing', async () => {
    queryRaw.mockResolvedValueOnce([{ managed: false }]);
    expect(await managesImageCollection({ imageId: 1, postId: null, userId: 43 })).toBe(false);
    queryRaw.mockResolvedValueOnce([]);
    expect(await managesImageCollection({ imageId: 1, postId: null, userId: 43 })).toBe(false);
  });
});
