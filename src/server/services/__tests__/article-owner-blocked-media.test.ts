import { describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { NsfwLevel } from '~/server/common/enums';
import type * as DbLagHelpers from '~/server/db/db-lag-helpers';
import type * as SystemCache from '~/server/services/system-cache';
import type * as UserService from '~/server/services/user.service';
import type * as FileService from '~/server/services/file.service';

/**
 * The article's own read for its author: a cover, banner or body image whose block refuses its owner
 * the media (`ownerMediaAllowed`) reaches them as a notice row with no url or blur hash, or not at all
 * in the body. An exempt block, and a moderator, keep the media.
 */

vi.mock('~/server/search-index', () => ({
  articlesSearchIndex: { queueUpdate: vi.fn(async () => undefined) },
  bountiesSearchIndex: { queueUpdate: vi.fn() },
  collectionsSearchIndex: { queueUpdate: vi.fn() },
  comicsSearchIndex: { queueUpdate: vi.fn() },
  modelsSearchIndex: { queueUpdate: vi.fn() },
}));
vi.mock('~/server/services/notification.service', () => ({ createNotification: vi.fn() }));
vi.mock('~/server/db/db-lag-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DbLagHelpers>()),
  getDbWithoutLag: vi.fn(async () => dbMock.dbRead),
}));
vi.mock('~/server/services/system-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof SystemCache>()),
  getCategoryTags: vi.fn(async () => []),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));
vi.mock('~/server/services/file.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FileService>()),
  getFilesByEntity: vi.fn(async () => []),
}));

const { getArticleById } = await import('~/server/services/article.service');

const ARTICLE_ID = 1;
const OWNER = 7;
const MODERATOR = 9;

const image = (id: number, blockedFor: string | null) => ({
  id,
  url: `key-${id}`,
  hash: 'blur-hash',
  userId: OWNER,
  nsfwLevel: NsfwLevel.PG,
  ingestion: blockedFor ? 'Blocked' : 'Scanned',
  blockedFor,
  needsReview: null,
  tosViolation: false,
  modelRestricted: false,
  width: 1,
  height: 1,
  minor: false,
  meta: null,
  metadata: null,
  tags: [],
});

const read = async (
  blockedFor: string | null,
  viewer: { userId: number; isModerator?: boolean }
) => {
  const cover = image(10, blockedFor);
  const banner = image(11, blockedFor);
  const body = image(12, blockedFor);
  const clean = image(13, null);
  dbMock.dbRead.article.findFirst.mockResolvedValue({
    id: ARTICLE_ID,
    userId: OWNER,
    nsfwLevel: NsfwLevel.PG,
    cover: cover.url,
    content: `<p>text</p><img src="${body.url}"><img src="${clean.url}">`,
    tags: [],
    metadata: null,
    coverImage: cover,
    bannerImage: banner,
  } as never);
  dbMock.dbRead.imageConnection.findMany.mockResolvedValue([
    { image: body },
    { image: clean },
  ] as never);
  return getArticleById({ id: ARTICLE_ID, ...viewer });
};

describe.each(['tos', 'moderated'])(
  'getArticleById for the author of a %s-blocked image',
  (blockedFor) => {
    it('serves the cover and banner as notice rows with no url or blur hash', async () => {
      const article = await read(blockedFor, { userId: OWNER });
      for (const row of [article.coverImage, article.bannerImage])
        expect(row).toMatchObject({ url: null, hash: null, blockedFor, ingestion: 'Blocked' });
      expect(article.cover).toBeNull();
    });

    it('leaves the blocked body image out of the content and its image list', async () => {
      const article = await read(blockedFor, { userId: OWNER });
      expect(article.contentImages.map((i) => i.id)).toEqual([13]);
      expect(article.content).not.toContain('key-12');
      expect(article.content).toContain('key-13');
    });

    it('keeps every one with its media for a moderator', async () => {
      const article = await read(blockedFor, { userId: MODERATOR, isModerator: true });
      expect(article.coverImage).toMatchObject({ url: 'key-10', hash: 'blur-hash' });
      expect(article.bannerImage).toMatchObject({ url: 'key-11' });
      expect(article.contentImages.map((i) => i.id)).toEqual([12, 13]);
    });
  }
);

describe('getArticleById for the author of an image under an exempt block', () => {
  it('serves the cover and the body image with their media', async () => {
    const article = await read('AiNotVerified', { userId: OWNER });
    expect(article.coverImage).toMatchObject({ url: 'key-10', hash: 'blur-hash' });
    expect(article.cover).toBe('key-10');
    expect(article.contentImages.map((i) => i.id)).toEqual([12, 13]);
  });
});
