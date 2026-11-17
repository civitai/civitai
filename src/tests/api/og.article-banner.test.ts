import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import type * as OgImageHelpers from '~/server/utils/og-image-helpers';
import { dbMock } from '~/__tests__/mocks/db.mock';

/**
 * An article's share card shows its cover, else its banner once servable: the article page hides
 * a banner that is unscanned or awaiting review, so the card must not show it either.
 */

const { fetchImageAsDataUri } = vi.hoisted(() => ({ fetchImageAsDataUri: vi.fn() }));
vi.mock('~/server/utils/og-image-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof OgImageHelpers>()),
  fetchImageAsDataUri,
}));

import handler from '~/pages/api/og';

const image = (url: string) => ({ url, nsfwLevel: 1, type: 'image', width: 100, height: 100 });
const banner = (ingestion: string, needsReview: string | null = null) => ({
  ...image('banner-key'),
  ingestion,
  needsReview,
});

const render = async () => {
  const res = {
    status: vi.fn(() => res),
    setHeader: vi.fn(() => res),
    send: vi.fn(() => res),
    json: vi.fn(() => res),
    end: vi.fn(() => res),
  } as unknown as NextApiResponse;
  await handler(
    {
      method: 'GET',
      query: { type: 'article', id: '7' },
      headers: {},
    } as unknown as NextApiRequest,
    res
  );
};

const pickedImage = () =>
  fetchImageAsDataUri.mock.calls
    .map((c) => String(c[0]).match(/(cover|banner)-key/)?.[0])
    .find(Boolean) ?? null;

const mockArticle = (images: { coverImage: unknown; bannerImage: unknown }) =>
  dbMock.dbRead.article.findFirst.mockResolvedValue({
    title: 'A',
    content: '',
    user: { username: 'u' },
    ...images,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  fetchImageAsDataUri.mockResolvedValue(null);
  dbMock.dbRead.articleMetric.findFirst.mockResolvedValue(null);
});

describe('/api/og?type=article image', () => {
  it('shows the banner of an article with no cover', async () => {
    mockArticle({ coverImage: null, bannerImage: banner('Scanned') });
    await render();
    expect(pickedImage()).toBe('banner-key');
  });

  it.each([
    ['has not finished scanning', banner('Pending')],
    ['awaits review', banner('Scanned', 'minor')],
  ])('shows no image when the only banner %s', async (_, bannerImage) => {
    mockArticle({ coverImage: null, bannerImage });
    await render();
    expect(pickedImage()).toBeNull();
  });

  it('shows the cover over the banner', async () => {
    mockArticle({
      coverImage: { ...image('cover-key'), ingestion: 'Scanned', needsReview: null },
      bannerImage: banner('Scanned'),
    });
    await render();
    expect(pickedImage()).toBe('cover-key');
  });

  it.each([
    ['has not finished scanning', 'Pending', null],
    ['awaits review', 'Scanned', 'minor'],
  ])('shows the banner over a cover that %s', async (_, ingestion, needsReview) => {
    mockArticle({
      coverImage: { ...image('cover-key'), ingestion, needsReview },
      bannerImage: banner('Scanned'),
    });
    await render();
    expect(pickedImage()).toBe('banner-key');
  });
});
