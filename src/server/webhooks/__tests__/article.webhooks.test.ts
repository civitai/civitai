import { describe, expect, it, vi } from 'vitest';
import '~/__tests__/mocks/logging.mock';
import '~/__tests__/mocks/env.mock';

const withheld = vi.hoisted(() => ({ ids: new Set<number>() }));
vi.mock('~/server/services/collection-cover-visibility', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getModelWithheldImageIds: vi.fn(async () => withheld.ids),
}));
vi.mock('~/server/services/system-cache', () => ({
  getCategoryTags: vi.fn(async () => []),
}));

import { articleWebhooks } from '~/server/webhooks/article.webhooks';

const image = (id: number, extra: Record<string, unknown> = {}) => ({
  id,
  url: `key-${id}`,
  nsfwLevel: 1,
  ingestion: 'Scanned',
  needsReview: null,
  blockedFor: null,
  ...extra,
});

const article = (coverImage: unknown, cover: string | null = 'cover-key') => ({
  id: 1,
  title: 't',
  cover,
  coverImage,
  user: { username: 'u', image: null },
  tags: [],
});

async function send(articles: unknown[], ids: number[] = []) {
  withheld.ids = new Set(ids);
  const findMany = vi.fn(async () => articles);
  const payload = await articleWebhooks['new-article'].getData({
    lastSent: new Date(0),
    prisma: { article: { findMany } },
  } as never);
  return { payload, findMany };
}

describe('new-article webhook payload', () => {
  it('sends only articles anyone may read', async () => {
    const { findMany } = await send([]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'Published',
          tosViolation: false,
          availability: 'Public',
          unlisted: false,
        }),
      })
    );
  });

  it('sends a servable cover', async () => {
    const { payload } = await send([article(image(10))]);
    expect(payload[0].coverImage).toMatchObject({ id: 10 });
    expect(payload[0].cover).toEqual(expect.stringContaining('cover-key'));
  });

  it.each([
    ['its model withholds', image(10), [10]],
    ['is blocked', image(10, { ingestion: 'Blocked' }), []],
    ['awaits review', image(10, { needsReview: 'minor' }), []],
    ['is not scanned yet', image(10, { ingestion: 'Pending' }), []],
  ])('🔴 sends no cover, as image or URL, that %s', async (_, cover, ids) => {
    const { payload } = await send([article(cover)], ids);
    expect(payload[0].coverImage).toBeNull();
    expect(payload[0].cover).toBeNull();
  });

  it('keeps the cover URL of an article with no cover image', async () => {
    const { payload } = await send([article(null)]);
    expect(payload[0].cover).toEqual(expect.stringContaining('cover-key'));
  });
});
