import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockProcessEngagement, mockQueueUpdate, mockRefreshCount, mockCreateNotification } =
  vi.hoisted(() => ({
    mockProcessEngagement: vi.fn(async () => undefined),
    mockQueueUpdate: vi.fn(async () => undefined),
    mockRefreshCount: vi.fn(async () => undefined),
    mockCreateNotification: vi.fn(async () => undefined),
  }));

vi.mock('~/server/events', () => ({ eventEngine: { processEngagement: mockProcessEngagement } }));
vi.mock('~/server/search-index', () => ({ articlesSearchIndex: { queueUpdate: mockQueueUpdate } }));
vi.mock('~/server/redis/caches', () => ({ userArticleCountCache: { refresh: mockRefreshCount } }));
vi.mock('~/server/services/notification.service', () => ({
  createNotification: mockCreateNotification,
}));

import { dbMock } from '~/__tests__/mocks/db.mock';
import { publishDueScheduledArticles } from '~/server/services/article-schedule.service';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

type Row = {
  id: number;
  userId: number;
  status: ArticleStatus;
  ingestion: ArticleIngestionStatus;
  publishedAt: Date | null;
  scheduledAt: Date | null;
  user: { bannedAt: Date | null; muted: boolean; deletedAt: Date | null };
};

type Where = Partial<Record<keyof Row, unknown>>;

// The two operators the service uses, with Prisma's meaning: a bare value is equality (null
// included), `{ lte }` is a range bound that never matches NULL.
function matches(row: Row, where: Where) {
  return Object.entries(where).every(([key, cond]) => {
    const value = row[key as keyof Row];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const { lte } = cond as { lte?: Date };
      if (lte === undefined) throw new Error(`fake does not implement ${JSON.stringify(cond)}`);
      return value instanceof Date && value.getTime() <= lte.getTime();
    }
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    return value === cond;
  });
}

let table: Row[] = [];
const article = dbMock.dbWrite.article;

const NOW = new Date('2026-10-20T16:00:00.000Z');
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

const draft = (over: Partial<Row> & { id: number }): Row => ({
  userId: 7,
  status: ArticleStatus.Draft,
  ingestion: ArticleIngestionStatus.Scanned,
  publishedAt: null,
  scheduledAt: minutes(-1),
  user: { bannedAt: null, muted: false, deletedAt: null },
  ...over,
});

// Runs `change` on the table after the job's read and before its writes.
function changeAfterRead(change: () => void) {
  const read = article.findMany.getMockImplementation()!;
  article.findMany.mockImplementationOnce(async (args: never) => {
    const rows = await read(args);
    change();
    return rows;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  table = [];
  article.findMany.mockImplementation(
    async ({ where, take }: { where: Where; take: number }) =>
      // Copies, as a real read returns: the service must not see a later write through them.
      table
        .filter((row) => matches(row, where))
        .slice(0, take)
        .map((row) => ({ ...row })) as never
  );
  article.updateMany.mockImplementation(
    async ({ where, data }: { where: Where; data: Partial<Row> }) => {
      const hit = table.filter((row) => matches(row, where));
      for (const row of hit) Object.assign(row, data);
      return { count: hit.length } as never;
    }
  );
});

describe('publishDueScheduledArticles', () => {
  it('takes an article scheduled in the past live, and leaves one scheduled in the future alone', async () => {
    table = [draft({ id: 1, scheduledAt: minutes(-1) }), draft({ id: 2, scheduledAt: minutes(1) })];

    const result = await publishDueScheduledArticles(NOW);

    expect(result).toEqual({ published: [1], processing: [], failed: [] });
    expect(table[0]).toMatchObject({
      status: ArticleStatus.Published,
      publishedAt: NOW,
      scheduledAt: null,
    });
    expect(table[1]).toMatchObject({
      status: ArticleStatus.Draft,
      publishedAt: null,
      scheduledAt: minutes(1),
    });
  });

  it('publishes an article due exactly now', async () => {
    table = [draft({ id: 1, scheduledAt: NOW })];
    expect((await publishDueScheduledArticles(NOW)).published).toEqual([1]);
  });

  it('ignores a cancelled schedule and anything that is not a draft', async () => {
    table = [
      draft({ id: 1, scheduledAt: null }),
      draft({ id: 2, status: ArticleStatus.Published, publishedAt: minutes(-60) }),
      draft({ id: 3, status: ArticleStatus.Unpublished }),
    ];
    const before = structuredClone(table);

    expect(await publishDueScheduledArticles(NOW)).toEqual({
      published: [],
      processing: [],
      failed: [],
    });
    expect(table).toEqual(before);
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });

  it('sends a pending-scan article to Processing with publishedAt still NULL', async () => {
    table = [
      draft({ id: 1, ingestion: ArticleIngestionStatus.Pending }),
      draft({ id: 2, ingestion: ArticleIngestionStatus.Rescan }),
    ];

    expect((await publishDueScheduledArticles(NOW)).processing).toEqual([1, 2]);
    for (const row of table)
      expect(row).toMatchObject({
        status: ArticleStatus.Processing,
        publishedAt: null,
        scheduledAt: null,
      });
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });

  it('drops the schedule of a blocked article, keeps it a draft and tells the owner', async () => {
    table = [draft({ id: 1, userId: 9, ingestion: ArticleIngestionStatus.Blocked })];

    expect((await publishDueScheduledArticles(NOW)).failed).toEqual([1]);
    expect(table[0]).toMatchObject({
      status: ArticleStatus.Draft,
      publishedAt: null,
      scheduledAt: null,
    });
    expect(mockCreateNotification).toHaveBeenCalledTimes(1);
    expect(mockCreateNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 9,
        type: 'system-message',
        details: expect.objectContaining({ url: '/articles/1/edit' }),
      })
    );
  });

  it('runs the publish side effects once per published article', async () => {
    table = [draft({ id: 1, userId: 5 })];

    await publishDueScheduledArticles(NOW);

    expect(mockProcessEngagement).toHaveBeenCalledExactlyOnceWith({
      userId: 5,
      type: 'published',
      entityType: 'article',
      entityId: 1,
    });
    expect(mockQueueUpdate).toHaveBeenCalledExactlyOnceWith([{ id: 1, action: 'Update' }]);
    expect(mockRefreshCount).toHaveBeenCalledExactlyOnceWith(5);
    expect(mockCreateNotification).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: 5, key: 'article-published-1' })
    );
  });

  it('leaves a row whose state changed after the read for the next run', async () => {
    table = [draft({ id: 1 })];
    // A cancel lands between the job's read and its write.
    changeAfterRead(() => (table[0].scheduledAt = null));

    expect((await publishDueScheduledArticles(NOW)).published).toEqual([]);
    expect(table[0]).toMatchObject({ status: ArticleStatus.Draft, publishedAt: null });
    expect(mockProcessEngagement).not.toHaveBeenCalled();
  });

  it('does not publish an article whose scan was blocked after the read', async () => {
    table = [draft({ id: 1 })];
    changeAfterRead(() => (table[0].ingestion = ArticleIngestionStatus.Blocked));

    expect((await publishDueScheduledArticles(NOW)).published).toEqual([]);
    expect(table[0]).toMatchObject({ status: ArticleStatus.Draft, publishedAt: null });
  });

  it('does not publish an article that went live by hand after the read', async () => {
    table = [draft({ id: 1 })];
    const manual = minutes(-30);
    changeAfterRead(() => Object.assign(table[0], { publishedAt: manual }));

    expect((await publishDueScheduledArticles(NOW)).published).toEqual([]);
    expect(table[0].publishedAt).toEqual(manual);
  });

  it('tells nobody about a failed article whose schedule was cancelled after the read', async () => {
    table = [draft({ id: 1, ingestion: ArticleIngestionStatus.Blocked })];
    changeAfterRead(() => (table[0].scheduledAt = null));

    expect((await publishDueScheduledArticles(NOW)).failed).toEqual([]);
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it('treats a scan error like a block', async () => {
    table = [draft({ id: 1, ingestion: ArticleIngestionStatus.Error })];

    expect((await publishDueScheduledArticles(NOW)).failed).toEqual([1]);
    expect(table[0]).toMatchObject({ status: ArticleStatus.Draft, scheduledAt: null });
  });

  it('keys the failure notice on the schedule, so a later schedule is told again', async () => {
    const scheduledAt = minutes(-3);
    table = [draft({ id: 4, ingestion: ArticleIngestionStatus.Blocked, scheduledAt })];

    await publishDueScheduledArticles(NOW);

    expect(mockCreateNotification).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: `article-schedule-failed-4-${scheduledAt.getTime()}` })
    );
  });

  it('refreshes the count cache for an article sent to Processing', async () => {
    table = [draft({ id: 1, userId: 3, ingestion: ArticleIngestionStatus.Pending })];

    await publishDueScheduledArticles(NOW);

    expect(mockRefreshCount).toHaveBeenCalledExactlyOnceWith(3);
  });

  it("withdraws, without publishing or notifying, a banned or muted author's article", async () => {
    table = [
      draft({ id: 1, user: { bannedAt: minutes(-10), muted: false, deletedAt: null } }),
      draft({ id: 2, user: { bannedAt: null, muted: true, deletedAt: null } }),
    ];

    expect(await publishDueScheduledArticles(NOW)).toEqual({
      published: [],
      processing: [],
      failed: [],
    });
    for (const row of table)
      expect(row).toMatchObject({
        status: ArticleStatus.Draft,
        publishedAt: null,
        scheduledAt: null,
      });
    expect(mockProcessEngagement).not.toHaveBeenCalled();
    expect(mockCreateNotification).not.toHaveBeenCalled();
  });

  it("keeps going when one article's side effects fail", async () => {
    table = [draft({ id: 1, userId: 1 }), draft({ id: 2, userId: 2 })];
    mockCreateNotification.mockRejectedValueOnce(new Error('notification service down'));

    expect((await publishDueScheduledArticles(NOW)).published).toEqual([1, 2]);
    expect(mockProcessEngagement).toHaveBeenCalledTimes(2);
    expect(mockProcessEngagement).toHaveBeenLastCalledWith(
      expect.objectContaining({ entityId: 2 })
    );
  });

  // The fake returns whole rows and ignores `select`, so pin it: without `user` in the real read,
  // the standing check throws on the first due article and nothing goes live.
  it('reads the author standing it decides on', async () => {
    await publishDueScheduledArticles(NOW);

    expect(article.findMany.mock.calls[0][0].select.user).toEqual({
      select: { bannedAt: true, muted: true, deletedAt: true },
    });
  });
});
