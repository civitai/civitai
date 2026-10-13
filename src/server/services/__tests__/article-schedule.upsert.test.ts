import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';

// upsertArticle's scheduling rules. Same stubs as article-locked-properties.service.test.ts: the
// post-commit Redis helpers would otherwise never settle.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => {}),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: { ...actual.userArticleCountCache, refresh: vi.fn(async () => {}) },
  };
});

import { upsertArticle } from '~/server/services/article.service';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

const ARTICLE_ID = 21;
const OWNER_ID = 7;
const inHours = (n: number) => new Date(Date.now() + n * 3_600_000);

function mockStored(over: { publishedAt?: Date | null; status?: ArticleStatus } = {}) {
  const row = {
    id: ARTICLE_ID,
    title: 'Stored title',
    cover: null,
    coverId: null,
    userId: OWNER_ID,
    publishedAt: null,
    status: ArticleStatus.Draft,
    nsfwLevel: 1,
    userNsfwLevel: 1,
    moderatorNsfwLevel: null,
    lockedProperties: [],
    metadata: {},
    content: 'stored content',
    ...over,
  };
  mockDbWrite.article.findUnique.mockResolvedValue(row);
  mockDbRead.article.findUnique.mockResolvedValue(row);
  mockDbWrite.article.findFirst.mockResolvedValue(row);
}

// The first article.update is the form write; later ones are post-commit scan bookkeeping.
function updateData() {
  expect(mockDbWrite.article.update).toHaveBeenCalled();
  return mockDbWrite.article.update.mock.calls[0][0].data;
}

const upsert = (input: Record<string, unknown>) =>
  upsertArticle({
    id: ARTICLE_ID,
    userId: OWNER_ID,
    title: 'A title',
    content: 'Some content',
    ...input,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mockStored();
  mockDbWrite.article.update.mockResolvedValue({ id: ARTICLE_ID, userId: OWNER_ID, tags: [] });
  mockDbWrite.article.create.mockResolvedValue({ id: ARTICLE_ID, userId: OWNER_ID, content: '' });
  mockDbWrite.imageConnection.findMany.mockResolvedValue([]);
  mockDbWrite.image.findMany.mockResolvedValue([]);
  mockDbRead.image.findMany.mockResolvedValue([]);
});

describe('upsertArticle — scheduling', () => {
  it('schedules a never-published draft without making it public', async () => {
    const when = inHours(2);
    await upsert({ status: ArticleStatus.Draft, scheduledAt: when });

    const data = updateData();
    expect(data.scheduledAt).toEqual(when);
    expect(data.status).toBe(ArticleStatus.Draft);
    expect(data.publishedAt).toBeNull();
  });

  it('keeps a scheduled save a Draft even when the payload asks to publish', async () => {
    await upsert({ status: ArticleStatus.Published, scheduledAt: inHours(2) });

    const data = updateData();
    expect(data.status).toBe(ArticleStatus.Draft);
    expect(data.publishedAt).toBeNull();
  });

  it('refuses to schedule an article that has been public', async () => {
    mockStored({ publishedAt: inHours(-48), status: ArticleStatus.Unpublished });

    await expect(upsert({ scheduledAt: inHours(2) })).rejects.toThrow(/never been published/);
    expect(mockDbWrite.article.update).not.toHaveBeenCalled();
  });

  it('refuses a date inside the minimum lead time', async () => {
    await expect(upsert({ scheduledAt: new Date(Date.now() + 60_000) })).rejects.toThrow(
      /at least 10 minutes/
    );
    expect(mockDbWrite.article.update).not.toHaveBeenCalled();
  });

  it('leaves the stored schedule alone on a plain save', async () => {
    await upsert({ status: ArticleStatus.Draft });

    expect(updateData().scheduledAt).toBeUndefined();
  });

  it('clears the schedule on cancel', async () => {
    await upsert({ status: ArticleStatus.Draft, scheduledAt: null });

    const data = updateData();
    expect(data.scheduledAt).toBeNull();
    expect(data.publishedAt).toBeNull();
  });

  it('clears the schedule when the article is published now', async () => {
    await upsert({ status: ArticleStatus.Published });

    const data = updateData();
    expect(data.scheduledAt).toBeNull();
    expect(data.publishedAt).toBeInstanceOf(Date);
  });

  it('schedules a new article as a Draft', async () => {
    const when = inHours(2);
    await upsert({ id: undefined, status: ArticleStatus.Published, scheduledAt: when });

    expect(mockDbWrite.article.create).toHaveBeenCalledTimes(1);
    const data = mockDbWrite.article.create.mock.calls[0][0].data;
    expect(data.scheduledAt).toEqual(when);
    expect(data.status).toBe(ArticleStatus.Draft);
    expect(data.publishedAt).toBeUndefined();
  });
});
