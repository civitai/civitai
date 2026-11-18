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
  // The column's default: the image's base model does not restrict it.
  modelRestricted: false,
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
  // A cover read without `minor` comes back without it, so a select that drops the flag fails here.
  const findMany = vi.fn(
    async (args: { select?: { coverImage?: { select?: { minor?: boolean } } } }) =>
      articles.map((row) => {
        const { coverImage } = row as { coverImage?: Record<string, unknown> | null };
        if (!coverImage || args?.select?.coverImage?.select?.minor) return row;
        const { minor: _minor, ...unflagged } = coverImage;
        return { ...(row as object), coverImage: unflagged };
      })
  );
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
    ['is a restricted minor image', image(10, { minor: true, nsfwLevel: 4 }), []],
  ])('🔴 sends no cover, as image or URL, that %s', async (_, cover, ids) => {
    const { payload } = await send([article(cover)], ids);
    expect(payload[0].coverImage).toBeNull();
    expect(payload[0].cover).toBeNull();
  });

  it('sends a minor-flagged PG-13 cover and an unflagged R cover, without the flag (control)', async () => {
    for (const extra of [
      { minor: true, nsfwLevel: 2 },
      { minor: false, nsfwLevel: 4 },
    ]) {
      const { payload } = await send([article(image(10, extra))]);
      expect(payload[0].coverImage).toMatchObject({ id: 10 });
      expect(payload[0].coverImage).not.toHaveProperty('minor');
    }
  });

  it('keeps the cover URL of an article with no cover image', async () => {
    const { payload } = await send([article(null)]);
    expect(payload[0].cover).toEqual(expect.stringContaining('cover-key'));
  });
});
