import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as ArticleService from '~/server/services/article.service';
import type * as SystemCache from '~/server/services/system-cache';

const { mockUpsertArticle } = vi.hoisted(() => ({ mockUpsertArticle: vi.fn() }));

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  upsertArticle: mockUpsertArticle,
}));
// The handler's adminOnly-category check reads the system cache, which throws without redis.
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: async () => [],
}));

import { upsertArticleHandler } from '../article.controller';

const ctx = (articleScheduling: boolean) =>
  ({
    user: { id: 7, isModerator: false },
    features: { articleImageScanning: false, articleScheduling },
    req: undefined,
    track: { article: vi.fn(async () => undefined) },
  } as never);

const input = (scheduledAt?: Date | null) =>
  ({
    id: 5,
    title: 't',
    content: '<p>c</p>',
    ...(scheduledAt === undefined ? {} : { scheduledAt }),
  } as never);

const inTwoHours = () => new Date(Date.now() + 2 * 3_600_000);

describe('upsertArticleHandler — articleScheduling flag', () => {
  beforeEach(() => {
    mockUpsertArticle.mockReset();
    mockUpsertArticle.mockResolvedValue({ id: 5, publishedAt: null });
    dbMock.dbRead.article.findUnique.mockResolvedValue({ publishedAt: null });
  });

  it('refuses to schedule without the flag, and writes nothing', async () => {
    await expect(
      upsertArticleHandler({ input: input(inTwoHours()), ctx: ctx(false) })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockUpsertArticle).not.toHaveBeenCalled();
  });

  it('schedules with the flag', async () => {
    const when = inTwoHours();
    await upsertArticleHandler({ input: input(when), ctx: ctx(true) });

    expect(mockUpsertArticle).toHaveBeenCalledTimes(1);
    expect(mockUpsertArticle.mock.calls[0][0].scheduledAt).toEqual(when);
  });

  // The flag gates setting a time, not saving: a cancel, or a save that never mentions the
  // schedule, must still go through after the flag is turned off.
  it.each([
    ['a cancel', null],
    ['a plain save', undefined],
  ])('lets %s through without the flag', async (_label, scheduledAt) => {
    await upsertArticleHandler({ input: input(scheduledAt), ctx: ctx(false) });

    expect(mockUpsertArticle).toHaveBeenCalledTimes(1);
  });
});
