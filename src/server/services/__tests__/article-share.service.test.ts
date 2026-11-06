import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ArticleService from '~/server/services/article.service';
import type * as TextScanRoute from '~/server/services/text-scan/route';
import type * as UserService from '~/server/services/user.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/article.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ArticleService>()),
  updateArticleImageScanStatus: vi.fn(async () => undefined),
}));
vi.mock('~/server/services/text-scan/route', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanRoute>()),
  submitTextModerationOrScan: vi.fn(async () => ({ id: 'wf' })),
}));
vi.mock('~/server/services/user.service', async (importOriginal) => ({
  ...(await importOriginal<typeof UserService>()),
  amIBlockedByUser: vi.fn(async () => false),
}));

import { hashAccessToken } from '~/server/services/access-token.service';
import {
  createArticleShareLink,
  getArticleByShareToken,
  revokeArticleShareLink,
} from '~/server/services/article-share.service';
import { submitTextModerationOrScan } from '~/server/services/text-scan/route';
import { ArticleIngestionStatus, ArticleStatus } from '~/shared/utils/prisma/enums';

const AUTHOR = 10;
const STRANGER = 20;
const ARTICLE = 1;
const OTHER_ARTICLE = 2;
const TOKEN = 'a'.repeat(43);
const DAY = 24 * 60 * 60 * 1000;

const tokenRow = (over: Record<string, unknown> = {}) => ({
  id: 7,
  resourceType: 'Article',
  resourceId: ARTICLE,
  createdById: AUTHOR,
  createdAt: new Date(),
  expiresAt: new Date(Date.now() + DAY),
  revokedAt: null,
  ...over,
});

type ArticleOver = Record<string, unknown> & { user?: Record<string, unknown> };
const articles = (over: ArticleOver = {}) => {
  const { user, ...rest } = over;
  const base = (id: number) => ({
    id,
    title: `Article ${id}`,
    content: '<p>Body</p>',
    nsfwLevel: 1,
    updatedAt: new Date(),
    userId: AUTHOR,
    status: ArticleStatus.Draft,
    ingestion: ArticleIngestionStatus.Scanned,
    coverImage: null,
    user: {
      id: AUTHOR,
      username: 'author',
      bannedAt: null,
      muted: false,
      deletedAt: null,
      ...user,
    },
    ...(id === ARTICLE ? rest : {}),
  });
  // Answers whichever id the code asks for, so reading the wrong article shows up as its title.
  dbMock.dbWrite.article.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: number };
  }) => base(where.id)) as never);
};

const read = () => getArticleByShareToken({ token: TOKEN });

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbWrite.accessToken.findUnique.mockResolvedValue(tokenRow() as never);
  articles();
});

describe('getArticleByShareToken', () => {
  it('opens the draft the token was made for', async () => {
    const result = await read();
    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.article.title).toBe(`Article ${ARTICLE}`);
    expect(dbMock.dbWrite.accessToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: hashAccessToken(TOKEN) } })
    );
  });

  it('opens only the article the token names, never another', async () => {
    dbMock.dbWrite.accessToken.findUnique.mockResolvedValue(
      tokenRow({ resourceId: OTHER_ARTICLE }) as never
    );
    const result = await read();
    expect(result.status === 'ok' && result.article.title).toBe(`Article ${OTHER_ARTICLE}`);
  });

  it.each([
    ['unknown', null],
    ['expired', tokenRow({ expiresAt: new Date(Date.now() - 1000) })],
    ['revoked', tokenRow({ revokedAt: new Date() })],
    ['for another kind of resource', tokenRow({ resourceType: 'Model' })],
  ])('refuses a token that is %s', async (_, row) => {
    dbMock.dbWrite.accessToken.findUnique.mockResolvedValue(row as never);
    expect(await read()).toEqual({ status: 'unavailable' });
  });

  it('sends a published article to its public page instead of serving the draft view', async () => {
    articles({ status: ArticleStatus.Published });
    expect(await read()).toEqual({ status: 'published', url: `/articles/${ARTICLE}/article-1` });
  });

  it.each([ArticleStatus.UnpublishedViolation, ArticleStatus.Processing])(
    'refuses an article in %s',
    async (status) => {
      articles({ status });
      expect(await read()).toEqual({ status: 'unavailable' });
    }
  );

  it('opens an article the author unpublished', async () => {
    articles({ status: ArticleStatus.Unpublished });
    expect((await read()).status).toBe('ok');
  });

  it.each([
    [ArticleIngestionStatus.Pending, 'checking'],
    [ArticleIngestionStatus.Rescan, 'checking'],
    [ArticleIngestionStatus.Error, 'unavailable'],
    [ArticleIngestionStatus.Blocked, 'unavailable'],
  ])('does not show a draft whose checks are %s', async (ingestion, status) => {
    articles({ ingestion });
    expect(await read()).toEqual({ status });
  });

  it.each([
    ['banned', { bannedAt: new Date() }],
    ['muted', { muted: true }],
    ['deleted', { deletedAt: new Date() }],
  ])('refuses when the author is %s', async (_, user) => {
    articles({ user });
    expect(await read()).toEqual({ status: 'unavailable' });
  });

  it('refuses once the article belongs to someone other than the link creator', async () => {
    articles({ userId: STRANGER });
    expect(await read()).toEqual({ status: 'unavailable' });
  });
});

describe('createArticleShareLink', () => {
  const create = (userId = AUTHOR) =>
    createArticleShareLink({ articleId: ARTICLE, expiresInDays: 7, userId });

  beforeEach(() => {
    dbMock.dbWrite.accessToken.count.mockResolvedValue(0);
    dbMock.dbWrite.accessToken.create.mockImplementation((async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) => tokenRow(data)) as never);
  });

  it('stores only the hash of the token it returns, then sends the draft for checks', async () => {
    const { token } = await create();
    const stored = dbMock.dbWrite.accessToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(hashAccessToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(submitTextModerationOrScan).toHaveBeenCalledTimes(1);
  });

  it('refuses someone who does not own the article', async () => {
    await expect(create(STRANGER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(dbMock.dbWrite.accessToken.create).not.toHaveBeenCalled();
  });

  it.each([ArticleStatus.Published, ArticleStatus.UnpublishedViolation])(
    'refuses an article in %s',
    async (status) => {
      articles({ status });
      await expect(create()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      expect(dbMock.dbWrite.accessToken.create).not.toHaveBeenCalled();
    }
  );

  it('refuses a sixth active link', async () => {
    dbMock.dbWrite.accessToken.count.mockResolvedValue(5);
    await expect(create()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.accessToken.create).not.toHaveBeenCalled();
  });

  it('withdraws the link when the checks cannot be started', async () => {
    vi.mocked(submitTextModerationOrScan).mockRejectedValueOnce(new Error('down'));
    await expect(create()).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 7 }) })
    );
  });
});

describe('revokeArticleShareLink', () => {
  beforeEach(() => {
    dbMock.dbWrite.accessToken.findUnique.mockResolvedValue(tokenRow() as never);
  });

  it('refuses someone who neither made the link nor owns the article', async () => {
    await expect(revokeArticleShareLink({ id: 7, userId: STRANGER })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(dbMock.dbWrite.accessToken.updateMany).not.toHaveBeenCalled();
  });

  it('lets the author revoke whatever state the article is in', async () => {
    articles({ status: ArticleStatus.UnpublishedViolation });
    await revokeArticleShareLink({ id: 7, userId: AUTHOR });
    expect(dbMock.dbWrite.accessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7, revokedAt: null } })
    );
  });
});
