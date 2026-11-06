import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as ArticleService from '~/server/services/article.service';

const updateArticleImageScanStatus = vi.hoisted(() => vi.fn(async (_ids: number[]) => undefined));
vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  updateArticleImageScanStatus,
}));

const { fanOutArticleImageUpdates } = await import('~/server/utils/webhook-debounce');

type Row = { id: number; coverId: number | null; bannerId: number | null };
type Where = { coverId?: number; bannerId?: number; OR?: Where[] };
const matches = (row: Row, where: Where): boolean =>
  where.OR
    ? where.OR.some((w) => matches(row, w))
    : Object.entries(where).every(([k, v]) => row[k as keyof Row] === v);

/** A finished image scan re-derives every article showing that image. */
describe('fanOutArticleImageUpdates', () => {
  const articles: Row[] = [
    { id: 1, coverId: 10, bannerId: 11 },
    { id: 2, coverId: 20, bannerId: null },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    redisMock.redis.get.mockResolvedValue(null as never);
    dbMock.dbRead.imageConnection.findMany.mockResolvedValue([] as never);
    dbMock.dbRead.article.findMany.mockImplementation((async ({ where }: { where: Where }) =>
      articles.filter((a) => matches(a, where)).map(({ id }) => ({ id }))) as never);
  });
  afterEach(() => vi.useRealTimers());

  const rederived = async (imageId: number) => {
    await fanOutArticleImageUpdates(imageId);
    await vi.runAllTimersAsync();
    return updateArticleImageScanStatus.mock.calls.map(([ids]) => ids);
  };

  it('re-derives the article whose banner finished scanning', async () => {
    expect(await rederived(11)).toEqual([[1]]);
  });

  it('re-derives the article whose cover finished scanning', async () => {
    expect(await rederived(20)).toEqual([[2]]);
  });
});
