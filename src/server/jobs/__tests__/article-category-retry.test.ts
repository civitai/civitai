import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { redisMock } from '~/__tests__/mocks/redis.mock';
import type * as Backfill from '~/server/services/text-scan/article-category-backfill';

const { select, submit, enabled, mode } = vi.hoisted(() => ({
  select: vi.fn(),
  submit: vi.fn(),
  enabled: vi.fn(),
  mode: vi.fn(),
}));
vi.mock('~/server/services/text-scan/article-category-backfill', async (importOriginal) => ({
  ...(await importOriginal<typeof Backfill>()),
  selectUncategorizedArticles: select,
  submitArticleCategoryCalls: submit,
}));
vi.mock('~/server/services/text-scan/mode', () => ({
  isTextScanEnabled: enabled,
  getTextScanMode: mode,
}));

const { retryArticleCategories, MAX_CATEGORY_RETRIES, MAX_SUBMITS_PER_RUN } = await import(
  '~/server/jobs/article-category-retry'
);

const NOW = new Date('2026-11-19T12:00:00Z');
const incrBy = vi.mocked(redisMock.redis.incrBy);
const submittedIds = () => submit.mock.calls.flatMap(([ids]) => ids as number[]);
const capLogs = () =>
  vi
    .mocked(loggingMock.logToAxiom)
    .mock.calls.filter(([arg]) => (arg as { message?: string }).message === 'retry cap reached');

beforeEach(() => {
  vi.clearAllMocks();
  enabled.mockResolvedValue(true);
  mode.mockResolvedValue('active');
  select.mockResolvedValue([]);
  submit.mockImplementation(async (ids: number[]) =>
    ids.map((entityId) => ({ entityId, status: 'submitted' }))
  );
  incrBy.mockResolvedValue(1 as never);
});

describe('retryArticleCategories', () => {
  it('resends the category call for R+ articles still unclassified an hour after publish', async () => {
    select.mockResolvedValueOnce([990000001, 990000002]);
    const result = await retryArticleCategories(NOW);
    expect(select).toHaveBeenCalledWith({
      afterId: 0,
      limit: 200,
      includeMature: true,
      publishedBefore: new Date('2026-11-19T11:00:00Z'),
      client: dbMock.dbRead,
    });
    expect(submittedIds()).toEqual([990000001, 990000002]);
    expect(result).toMatchObject({ selected: 2, capped: 0, byStatus: { submitted: 2 } });
  });

  it('stops at 3 attempts per article and says so once', async () => {
    select.mockResolvedValue([7]);
    const attempts = [1, 2, 3, 4, 5];
    for (const n of attempts) {
      incrBy.mockResolvedValueOnce(n as never);
      await retryArticleCategories(NOW);
    }
    expect(submittedIds()).toEqual(Array(MAX_CATEGORY_RETRIES).fill(7));
    expect(capLogs()).toHaveLength(1);
  });

  it('sends nothing for an article whose attempt Redis could not count', async () => {
    select.mockResolvedValueOnce([7]);
    incrBy.mockRejectedValueOnce(new Error('redis down'));
    const result = await retryArticleCategories(NOW);
    expect(submit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ uncounted: 1 });
  });

  it('pages past capped articles, and sends at most one run cap of calls', async () => {
    const page = (from: number) => Array.from({ length: 200 }, (_, i) => from + i);
    select.mockResolvedValueOnce(page(1)).mockResolvedValueOnce(page(201));
    incrBy.mockImplementation((async (key: string) =>
      Number(key.split(':').pop()) <= 200 ? MAX_CATEGORY_RETRIES + 1 : 1) as never);
    await retryArticleCategories(NOW);
    expect(select.mock.calls.map(([arg]) => arg.afterId)).toEqual([0, 200]);
    expect(submittedIds()).toEqual(page(201).slice(0, MAX_SUBMITS_PER_RUN));
  });

  it('sends nothing for an article its rollout leaves off, and spends no attempt on it', async () => {
    select.mockResolvedValueOnce([990000001, 990000002]);
    mode.mockImplementation(async (_: string, id: number) => (id === 990000001 ? 'off' : 'shadow'));
    const result = await retryArticleCategories(NOW);
    expect(submittedIds()).toEqual([990000002]);
    expect(incrBy).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ outOfRollout: 1 });
  });

  it('selects nothing while text scanning is off', async () => {
    enabled.mockResolvedValue(false);
    await retryArticleCategories(NOW);
    expect(select).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
});
