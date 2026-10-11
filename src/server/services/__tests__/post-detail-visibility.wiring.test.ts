import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));

const { getPostDetail } = await import('~/server/services/post.service');

const findFirst = dbMock.dbRead.post.findFirst;
const publishedPost = { id: 1, publishedAt: new Date(0), detail: null, tags: [] };

describe('getPostDetail visibility', () => {
  beforeEach(() => {
    findFirst.mockReset().mockResolvedValue(publishedPost as never);
  });

  it('scopes an anonymous lookup to published, scanned posts only', async () => {
    await getPostDetail({ id: 1 });

    const { where } = findFirst.mock.calls[0][0] as { where: unknown };
    expect(where).toEqual({
      id: 1,
      OR: [{ publishedAt: { lt: expect.any(Date) }, nsfwLevel: { not: 0 } }],
    });
  });

  it('scopes the owner and collection-manager branches to the signed-in viewer', async () => {
    await getPostDetail({ id: 1, user: { id: 42, isModerator: false } as never });

    const { where } = findFirst.mock.calls[0][0] as { where: { OR: unknown[] } };
    expect(where.OR).toContainEqual({ userId: 42 });
    expect(JSON.stringify(where)).toContain('"contributors":{"some":{"userId":42');
  });
});
