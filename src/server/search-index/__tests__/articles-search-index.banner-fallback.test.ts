import { describe, expect, it } from 'vitest';
import { transformData } from '~/server/search-index/articles.search-index';

type Input = Parameters<typeof transformData>[0];

const image = (id: number, nsfwLevel: number, needsReview: string | null = null) => ({
  id,
  url: `key-${id}`,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview,
  meta: null,
  tags: [],
});

const article = (images: { coverImage: unknown; bannerImage: unknown }) =>
  ({
    id: 1,
    nsfwLevel: 1,
    content: '<p>Hi</p>',
    tags: [],
    stats: null,
    ...images,
  } as unknown as Input['articles'][number]);

describe('articles search index', () => {
  it('indexes a banner-only article with its banner as the card image', async () => {
    const [record] = await transformData({
      articles: [article({ coverImage: null, bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record?.coverImage).toMatchObject({ id: 11 });
    expect(record).not.toHaveProperty('bannerImage');
  });

  it('keeps the cover when there is one', async () => {
    const [record] = await transformData({
      articles: [article({ coverImage: image(10, 1), bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record?.coverImage).toMatchObject({ id: 10 });
  });

  it('leaves out a banner-only article whose banner awaits review', async () => {
    const records = await transformData({
      articles: [article({ coverImage: null, bannerImage: image(11, 1, 'minor') })],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });

  it('still leaves out an article with neither', async () => {
    const records = await transformData({
      articles: [article({ coverImage: null, bannerImage: null })],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });
});
