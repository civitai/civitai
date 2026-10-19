import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as RedisCaches from '~/server/redis/caches';
import { dbMock } from '~/__tests__/mocks/db.mock';

// Same stubs as article-schedule.upsert.test.ts: the post-commit Redis helpers would otherwise
// never settle.
const mockDbRead = dbMock.dbRead;
const mockDbWrite = dbMock.dbWrite;
vi.mock('~/server/services/blocklist.service', () => ({
  throwOnBlockedLinkDomain: vi.fn(),
  throwOnBlockedUserContent: vi.fn(),
}));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  preventReplicationLag: vi.fn(async () => undefined),
  getDbWithoutLag: vi.fn(async () => mockDbRead),
}));
vi.mock('~/server/redis/caches', async (importOriginal) => {
  const actual = await importOriginal<typeof RedisCaches>();
  return {
    ...actual,
    userArticleCountCache: {
      ...actual.userArticleCountCache,
      refresh: vi.fn(async () => undefined),
    },
  };
});

const { OFFICIAL_TAG } = vi.hoisted(() => ({
  OFFICIAL_TAG: { id: 900, name: 'civitai official' },
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getSystemTags: async () => [OFFICIAL_TAG],
}));

import { upsertArticle } from '~/server/services/article.service';
import { ArticleStatus } from '~/shared/utils/prisma/enums';

const ARTICLE_ID = 21;
const OWNER_ID = 7;

function mockStored() {
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
  };
  mockDbWrite.article.findUnique.mockResolvedValue(row);
  mockDbRead.article.findUnique.mockResolvedValue(row);
  mockDbWrite.article.findFirst.mockResolvedValue(row);
}

// The first article.update is the form write; later ones are post-commit scan bookkeeping.
function updateTags() {
  expect(mockDbWrite.article.update).toHaveBeenCalled();
  return mockDbWrite.article.update.mock.calls[0][0].data.tags;
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
  mockDbWrite.article.update.mockResolvedValue({
    id: ARTICLE_ID,
    userId: OWNER_ID,
    isOfficial: false,
    tags: [],
  });
  mockDbWrite.article.create.mockResolvedValue({ id: ARTICLE_ID, userId: OWNER_ID, content: '' });
  mockDbWrite.imageConnection.findMany.mockResolvedValue([]);
});

/**
 * The tag is derived from `Article.isOfficial`, so the one way a client could claim it — the
 * free-text tag list, which attaches by name — has to lose it before the write, for moderators
 * and members alike.
 */
describe('upsertArticle — the civitai official tag', () => {
  it('drops the official tag from the client tag list, by name and by id', async () => {
    await upsert({
      tags: [
        { id: 5, name: 'story' },
        { id: OFFICIAL_TAG.id, name: 'renamed' },
        { name: 'Civitai Official' },
        { name: 'workflows' },
      ],
    });

    const tags = updateTags();
    expect(tags.connectOrCreate.map((x: { create: { tagId: number } }) => x.create.tagId)).toEqual([
      5,
    ]);
    expect(tags.deleteMany.tagId.notIn).toEqual([5]);
    expect(
      tags.create.map(
        (x: { tag: { connectOrCreate: { where: { name: string } } } }) =>
          x.tag.connectOrCreate.where.name
      )
    ).toEqual(['workflows']);
  });

  // The tag rewrite above deletes every row not in the client's list, the official one
  // included, so an owner's ordinary edit would silently strip a moderator's mark.
  it('restores the tag from the column after a tag rewrite', async () => {
    mockDbWrite.article.update.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER_ID,
      isOfficial: true,
      tags: [],
    });

    await upsert({ tags: [{ id: 5, name: 'story' }] });

    expect(mockDbWrite.tagsOnArticle.createMany).toHaveBeenCalledWith({
      data: [{ articleId: ARTICLE_ID, tagId: OFFICIAL_TAG.id }],
      skipDuplicates: true,
    });
  });

  it('strips the tag on create and attaches it from the column', async () => {
    mockDbWrite.article.create.mockResolvedValue({
      id: ARTICLE_ID,
      userId: OWNER_ID,
      content: '',
      isOfficial: true,
    });

    await upsertArticle({
      userId: OWNER_ID,
      title: 'A title',
      content: 'Some content',
      tags: [{ name: 'civitai official' }, { name: 'workflows' }],
    } as never);

    const created = mockDbWrite.article.create.mock.calls[0][0].data.tags.create;
    expect(
      created.map(
        (x: { tag: { connectOrCreate: { where: { name: string } } } }) =>
          x.tag.connectOrCreate.where.name
      )
    ).toEqual(['workflows']);
    expect(mockDbWrite.tagsOnArticle.createMany).toHaveBeenCalledWith({
      data: [{ articleId: ARTICLE_ID, tagId: OFFICIAL_TAG.id }],
      skipDuplicates: true,
    });
  });

  it('attaches nothing on create when the article is not official', async () => {
    await upsertArticle({
      userId: OWNER_ID,
      title: 'A title',
      content: 'Some content',
      tags: [{ name: 'workflows' }],
    } as never);

    expect(mockDbWrite.tagsOnArticle.createMany).not.toHaveBeenCalled();
  });

  it('removes the tag when a moderator unmarks through the form', async () => {
    await upsert({ isOfficial: false });

    expect(mockDbWrite.tagsOnArticle.deleteMany).toHaveBeenCalledWith({
      where: { articleId: ARTICLE_ID, tagId: OFFICIAL_TAG.id },
    });
  });

  it('leaves the tag table alone when neither tags nor the mark are sent', async () => {
    await upsert({ title: 'Renamed' });

    expect(mockDbWrite.tagsOnArticle.createMany).not.toHaveBeenCalled();
    expect(mockDbWrite.tagsOnArticle.deleteMany).not.toHaveBeenCalled();
  });
});
