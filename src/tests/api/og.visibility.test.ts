import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as ChallengeService from '~/server/services/challenge.service';
import type * as FeatureFlagsService from '~/server/services/feature-flags.service';
import type * as ImageVisibilityService from '~/server/services/image-visibility.service';
import type * as ImageService from '~/server/services/image.service';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * Each card shows only what its own page shows an anonymous viewer. A hidden entity renders
 * the fallback card, which is the only response that takes the one-hour cache; a real card
 * takes the week-long one. That header is the observable.
 */

const {
  assertImageVisibleToViewer,
  getChallengeDetail,
  getFeatureFlagsAsync,
  getImageMetricsObject,
} = vi.hoisted(() => ({
  assertImageVisibleToViewer: vi.fn(),
  getImageMetricsObject: vi.fn(async () => ({})),
  getChallengeDetail: vi.fn(),
  getFeatureFlagsAsync: vi.fn(),
}));
// Image stats read a live cache; the card swallows its failure, but only after a timeout.
vi.mock('~/server/services/image.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageService>()),
  getImageMetricsObject,
}));
vi.mock('~/server/services/image-visibility.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ImageVisibilityService>()),
  assertImageVisibleToViewer,
}));
vi.mock('~/server/services/challenge.service', async (importOriginal) => ({
  ...(await importOriginal<typeof ChallengeService>()),
  getChallengeDetail,
}));
vi.mock('~/server/services/feature-flags.service', async (importOriginal) => ({
  ...(await importOriginal<typeof FeatureFlagsService>()),
  getFeatureFlagsAsync,
}));

import handler from '~/pages/api/og';

const FALLBACK_CACHE = 'public, max-age=3600, s-maxage=3600';
const CARD_CACHE = 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400';

const render = async (type: string, id = 7) => {
  const headers: Record<string, string> = {};
  const res = {
    status: vi.fn(() => res),
    setHeader: vi.fn((k: string, v: string) => {
      headers[k.toLowerCase()] = v;
      return res;
    }),
    send: vi.fn(() => res),
    json: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as NextApiResponse;
  await handler(
    { method: 'GET', query: { type, id: String(id) }, headers: {} } as unknown as NextApiRequest,
    res
  );
  return headers['cache-control'];
};

// The mocked client ignores `where`, so this applies the operators the card queries use
// (equality, `not`, `lt`, `OR`) to one row and returns it only if it matches.
type Where = Record<string, unknown>;
function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond === undefined) return true;
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    const value = row[key];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; lt?: Date };
      if ('not' in c && (c.not === null ? value === null : value === c.not)) return false;
      if (c.lt !== undefined && !(value instanceof Date && value < c.lt)) return false;
      return true;
    }
    return value === cond;
  });
}
const fakeFindFirst =
  (row: Record<string, unknown>, result: unknown) =>
  async ({ where }: { where: Where }) =>
    matches(row, where) ? result : null;

const past = new Date('2020-01-01');
const future = new Date('2999-01-01');

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.dbRead.image.findFirst.mockResolvedValue(null);
  dbMock.dbRead.postMetric.findFirst.mockResolvedValue(null);
  dbMock.dbRead.articleMetric.findFirst.mockResolvedValue(null);
  getFeatureFlagsAsync.mockResolvedValue({
    challengePlatform: true,
    isGreen: true,
    userChallenges: false,
  });
});

describe('/api/og?type=post', () => {
  const card = { title: 'P', detail: '', user: { username: 'u' }, _count: { images: 1 } };
  const post = (over: Record<string, unknown>) => ({
    id: 7,
    availability: 'Public',
    publishedAt: past,
    nsfwLevel: 1,
    ...over,
  });

  it('renders a published public post', async () => {
    dbMock.dbRead.post.findFirst.mockImplementation(fakeFindFirst(post({}), card));
    expect(await render('post')).toBe(CARD_CACHE);
  });

  it.each([
    ['private', { availability: 'Private' }],
    ['scheduled for later', { publishedAt: future }],
    ['not yet rated', { nsfwLevel: 0 }],
  ])('hides a post that is %s', async (_, over) => {
    dbMock.dbRead.post.findFirst.mockImplementation(fakeFindFirst(post(over), card));
    expect(await render('post')).toBe(FALLBACK_CACHE);
  });
});

describe('/api/og?type=image', () => {
  beforeEach(() => {
    // A mature level renders the card without a cover, so no cover fetch decides the cache.
    dbMock.dbRead.image.findFirst.mockResolvedValue({
      url: 'u',
      nsfwLevel: 16,
      type: 'image',
      width: 1,
      height: 1,
      user: { username: 'u' },
      post: { title: 'T', modelVersion: null },
    });
  });

  it('asks the image page rule as an anonymous viewer, and renders when it admits', async () => {
    assertImageVisibleToViewer.mockResolvedValue({ userId: 1, nsfwLevel: 1, postId: 2 });
    expect(await render('image')).toBe(CARD_CACHE);
    expect(assertImageVisibleToViewer).toHaveBeenCalledWith({ id: 7 });
  });

  it('hides an image the image page would not show', async () => {
    assertImageVisibleToViewer.mockRejectedValue(new Error('NOT_FOUND'));
    expect(await render('image')).toBe(FALLBACK_CACHE);
  });
});

describe('/api/og?type=article', () => {
  const card = { title: 'A', content: '', user: { username: 'u' }, coverImage: null };
  const article = (over: Record<string, unknown>) => ({
    id: 7,
    publishedAt: past,
    status: 'Published',
    tosViolation: false,
    ingestion: 'Scanned',
    ...over,
  });

  it('renders a published article', async () => {
    dbMock.dbRead.article.findFirst.mockImplementation(fakeFindFirst(article({}), card));
    expect(await render('article')).toBe(CARD_CACHE);
  });

  it('hides an unpublished article that still carries its publish date', async () => {
    dbMock.dbRead.article.findFirst.mockImplementation(
      fakeFindFirst(article({ status: 'Unpublished' }), card)
    );
    expect(await render('article')).toBe(FALLBACK_CACHE);
  });
});

describe('/api/og?type=challenge', () => {
  const detail = {
    title: 'C',
    theme: null,
    invitation: null,
    description: null,
    coverImage: null,
    prizePool: 0,
    entryCount: 3,
    winners: [],
  };
  beforeEach(() => {
    // What the card would read if it bypassed the page's rule.
    dbMock.dbRead.challenge.findFirst.mockResolvedValue({
      ...detail,
      collection: { _count: { items: 3 } },
    });
  });

  it("renders what the challenge page returns to an anonymous viewer on this host's flags", async () => {
    getChallengeDetail.mockResolvedValue(detail);
    expect(await render('challenge')).toBe(CARD_CACHE);
    expect(getChallengeDetail).toHaveBeenCalledWith(7, undefined, true, false, false);
  });

  it('hides a challenge the page would not show', async () => {
    getChallengeDetail.mockResolvedValue(null);
    expect(await render('challenge')).toBe(FALLBACK_CACHE);
  });

  it('hides every challenge while the challenge platform is off', async () => {
    getFeatureFlagsAsync.mockResolvedValue({ challengePlatform: false });
    getChallengeDetail.mockResolvedValue(detail);
    expect(await render('challenge')).toBe(FALLBACK_CACHE);
  });
});
