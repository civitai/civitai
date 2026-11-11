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

  it.each(['Pending', 'Error'])(
    'indexes an article with a %s cover without it; the banner stands in when servable',
    async (state) => {
      const cover = { ...image(10, 1), ingestion: state };
      const withBanner = await transformData({
        articles: [article({ coverImage: cover, bannerImage: image(11, 1) })],
        cosmetics: {},
      });
      expect(withBanner[0]?.coverImage).toMatchObject({ id: 11 });

      const coverOnly = await transformData({
        articles: [article({ coverImage: cover, bannerImage: null })],
        cosmetics: {},
      });
      expect(coverOnly).toHaveLength(1);
      expect(coverOnly[0].coverImage).toBeUndefined();
    }
  );

  it.each([
    ['blocked', { blockedFor: 'tos' }],
    ['Blocked by its scan', { ingestion: 'Blocked' }],
    ['awaiting review', { needsReview: 'minor' }],
    ['flagged csam', { needsReview: 'csam' }],
  ])('leaves out an article whose cover is %s, banner or not', async (_, state) => {
    const cover = { ...image(10, 1), blockedFor: null, ...state };
    const records = await transformData({
      articles: [
        article({ coverImage: cover, bannerImage: image(11, 1) }),
        article({ coverImage: cover, bannerImage: null }),
      ],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });
});
