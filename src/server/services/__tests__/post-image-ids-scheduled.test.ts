import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { getPostImageIds } from '~/server/services/post.service';

// A scheduled post has a future publishedAt; the bound must be the clock, not "not null".
const NOW = new Date('2026-10-20T16:00:00.000Z');
const findMany = dbMock.dbRead.image.findMany;
const postFilter = () => findMany.mock.calls[0][0].where.post;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  findMany.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe('getPostImageIds', () => {
  it('admits a non-owner only to posts that are already live', async () => {
    await getPostImageIds({ id: 1, user: { id: 9, isModerator: false } as never });

    expect(postFilter()).toEqual({ OR: [{ publishedAt: { lte: NOW } }, { userId: 9 }] });
  });

  it('does not filter for a moderator', async () => {
    await getPostImageIds({ id: 1, user: { id: 9, isModerator: true } as never });

    expect(postFilter()).toBeUndefined();
  });
});
