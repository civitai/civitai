import type { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { managesPostCollection } from '~/server/utils/image-media-visibility';

/**
 * `managesPostCollection` hands an above-cap image's media to whoever it answers true for, so its
 * SQL is pinned whole: MANAGE on the collection the post was submitted to, on a post owned by the
 * image's owner, and nothing else. A collection merely holding the image must not count.
 */

const queryRaw = dbMock.dbRead.$queryRaw;

const normalise = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ').trim();

describe('managesPostCollection', () => {
  it('asks only whether this user holds MANAGE on the collection of this post', async () => {
    queryRaw.mockResolvedValueOnce([{ managed: true }]);
    expect(await managesPostCollection({ postId: 30, imageOwnerId: 7, userId: 42 })).toBe(true);

    const [sql] = queryRaw.mock.calls[0] as [Prisma.Sql];
    expect(normalise(sql)).toBe(
      [
        'SELECT EXISTS (',
        'SELECT 1 FROM "Post" p',
        'JOIN "CollectionContributor" cc ON cc."collectionId" = p."collectionId"',
        'WHERE p.id = ? AND p."userId" = ? AND cc."userId" = ?',
        `AND cc."permissions" && ARRAY['MANAGE']::"CollectionContributorPermission"[]`,
        ') AS managed',
      ].join(' ')
    );
    expect(sql.values).toEqual([30, 7, 42]);
  });

  it('answers false when the query finds nothing', async () => {
    queryRaw.mockResolvedValueOnce([{ managed: false }]);
    expect(await managesPostCollection({ postId: 30, imageOwnerId: 7, userId: 43 })).toBe(false);
    queryRaw.mockResolvedValueOnce([]);
    expect(await managesPostCollection({ postId: 30, imageOwnerId: 7, userId: 43 })).toBe(false);
  });
});
