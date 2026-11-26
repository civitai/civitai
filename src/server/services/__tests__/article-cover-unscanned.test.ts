import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type * as RedisCaches from '~/server/redis/caches';

// An article's own ingestion can read Scanned while its cover has not finished scanning (a
// moderator's rating stands in for the scan). Article cards then carry the cover only to its owner
// and moderators.

vi.mock('~/server/redis/caches', async (importOriginal) => ({
  ...(await importOriginal<typeof RedisCaches>()),
  tagIdsForImagesCache: { fetch: vi.fn().mockResolvedValue({}) },
  articleStatCache: { fetch: vi.fn().mockResolvedValue({}) },
}));
vi.mock('~/server/services/system-cache', () => ({
  getCategoryTags: vi.fn().mockResolvedValue([]),
  getSystemTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('~/server/services/profile-picture.sql', () => ({
  getServableProfilePictures: vi.fn().mockResolvedValue([]),
}));

const { getArticles, getCivitaiNews } = await import('~/server/services/article.service');
const { ArticleSort } = await import('~/server/common/enums');
const { MetricTimeframe } = await import('~/shared/utils/prisma/enums');

const AUTHOR = 5;
const STATES = ['Scanned', 'Pending', 'Error'] as const;
const coverOf = (i: number) => ({
  id: 100 + i,
  name: null,
  url: `cover-${STATES[i]}`,
  nsfwLevel: 1,
  width: 1,
  height: 1,
  hash: null,
  meta: null,
  userId: AUTHOR,
  generationProcess: null,
  needsReview: null,
  scannedAt: null,
  ingestion: STATES[i],
  blockedFor: null,
  postId: null,
  type: 'image',
  metadata: {},
  createdAt: new Date(0),
  hideMeta: false,
  tags: [],
});
const rows = STATES.map((_, i) => ({
  id: i + 1,
  userId: AUTHOR,
  user: { id: AUTHOR, username: 'author', image: null, deletedAt: null, profilePictureId: null },
  tags: [],
  userCosmetics: [],
  cursorV: 0,
  availability: 'Public',
  coverId: 100 + i,
  nsfwLevel: 1,
  collection: 'Newsroom',
  title: 't',
  content: 'c',
  publishedAt: new Date(0),
  featured: false,
}));

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.$queryRaw.mockResolvedValue(rows as never);
  dbMock.dbRead.image.findMany.mockResolvedValue(STATES.map((_, i) => coverOf(i)) as never);
  dbMock.dbRead.user.findMany.mockResolvedValue([] as never);
  dbMock.dbRead.pressMention.findMany.mockResolvedValue([] as never);
});

const feedCovers = async (
  sessionUser?: { id: number; isModerator?: boolean },
  browsingLevel = 1
) => {
  const { items } = await getArticles({
    limit: 10,
    sort: ArticleSort.Newest,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    browsingLevel,
    sessionUser,
  } as Parameters<typeof getArticles>[0]);
  return items.map((a) => a.coverImage?.url ?? null);
};

describe('article card covers', () => {
  it.each([
    ['signed out', undefined],
    ['another user', { id: 6 }],
  ])('the feed carries only a Scanned cover to a viewer %s', async (_, viewer) => {
    expect(await feedCovers(viewer)).toEqual(['cover-Scanned', null, null]);
  });

  it.each([
    ['the author', { id: AUTHOR }],
    ['a moderator', { id: 6, isModerator: true }],
  ])('the feed carries every cover to %s', async (_, viewer) => {
    expect(await feedCovers(viewer)).toEqual(['cover-Scanned', 'cover-Pending', 'cover-Error']);
  });

  it('the feed carries no cover awaiting review to a visitor', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue(
      STATES.map((_, i) => ({ ...coverOf(i), needsReview: 'minor' })) as never
    );
    expect(await feedCovers({ id: 6 })).toEqual([null, null, null]);
  });

  it.each([
    ['signed out', undefined],
    ['another user', { id: 6 }],
  ])('the feed carries no unrated cover to a viewer %s', async (_, viewer) => {
    dbMock.dbRead.image.findMany.mockResolvedValue(
      STATES.map((_, i) => ({ ...coverOf(i), nsfwLevel: 0 })) as never
    );
    expect(await feedCovers(viewer)).toEqual([null, null, null]);
  });

  it('the feed carries an unrated cover to its author', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue(
      STATES.map((_, i) => ({ ...coverOf(i), nsfwLevel: 0 })) as never
    );
    expect(await feedCovers({ id: AUTHOR })).toEqual([
      'cover-Scanned',
      'cover-Pending',
      'cover-Error',
    ]);
  });

  it('Civitai News carries only a Scanned cover', async () => {
    const { articles } = await getCivitaiNews();
    expect(articles.map((a) => a.coverImage?.url ?? null)).toEqual(['cover-Scanned', null, null]);
  });
});

describe('article card covers restricted by their base model', () => {
  const mature = (modelRestricted: boolean) =>
    STATES.map((_, i) => ({ ...coverOf(i), ingestion: 'Scanned', nsfwLevel: 4, modelRestricted }));
  const ALL = ['cover-Scanned', 'cover-Pending', 'cover-Error'];

  it.each([
    ['signed out', undefined],
    ['another user', { id: 6 }],
    ['a moderator', { id: 6, isModerator: true }],
  ])('the feed withholds a mature restricted cover from a viewer %s', async (_, viewer) => {
    dbMock.dbRead.image.findMany.mockResolvedValue(mature(true) as never);
    expect(await feedCovers(viewer, 31)).toEqual([null, null, null]);
    dbMock.dbRead.image.findMany.mockResolvedValue(mature(false) as never);
    expect(await feedCovers(viewer, 31)).toEqual(ALL);
  });

  it('the feed carries a mature restricted cover to its author', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue(mature(true) as never);
    expect(await feedCovers({ id: AUTHOR }, 31)).toEqual(ALL);
  });

  it('Civitai News withholds a mature restricted cover', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue(mature(true) as never);
    const { articles } = await getCivitaiNews();
    expect(articles.map((a) => a.coverImage?.url ?? null)).toEqual([null, null, null]);
    dbMock.dbRead.image.findMany.mockResolvedValue(mature(false) as never);
    const { articles: unrestricted } = await getCivitaiNews();
    expect(unrestricted.map((a) => a.coverImage?.url ?? null)).toEqual(ALL);
  });
});

describe('article card covers blocked by a moderation action', () => {
  const blocked = (blockedFor: string) =>
    STATES.map((_, i) => ({ ...coverOf(i), ingestion: 'Blocked', blockedFor, hash: 'blur-hash' }));
  const authorCovers = async (viewer: { id: number; isModerator?: boolean }) => {
    const { items } = await getArticles({
      limit: 10,
      sort: ArticleSort.Newest,
      period: MetricTimeframe.AllTime,
      periodMode: 'published',
      browsingLevel: 1,
      sessionUser: viewer,
    } as Parameters<typeof getArticles>[0]);
    return items.map((a) => (a.coverImage ? [a.coverImage.url, a.coverImage.hash] : null));
  };

  it.each(['tos', 'moderated'])(
    'the feed carries no %s-blocked cover to its author',
    async (blockedFor) => {
      dbMock.dbRead.image.findMany.mockResolvedValue(blocked(blockedFor) as never);
      expect(await authorCovers({ id: AUTHOR })).toEqual(STATES.map(() => null));
    }
  );

  it('the feed carries a cover under an exempt block to its author with its media', async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue(blocked('AiNotVerified') as never);
    expect(await authorCovers({ id: AUTHOR })).toEqual(
      STATES.map((s) => [`cover-${s}`, 'blur-hash'])
    );
  });
});
