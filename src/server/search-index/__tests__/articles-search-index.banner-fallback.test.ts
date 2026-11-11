import { describe, expect, it, vi } from 'vitest';

const meili = vi.hoisted(() => ({ updateDocs: vi.fn(), cleanup: vi.fn() }));
vi.mock('~/server/meilisearch/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateDocs: meili.updateDocs,
}));
vi.mock('~/server/meilisearch/util', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  onSearchIndexDocumentsCleanup: meili.cleanup,
}));

import { pushData, transformData } from '~/server/search-index/articles.search-index';

type Input = Parameters<typeof transformData>[0];
const recordsOf = async (input: Input) => (await transformData(input)).records;

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
    const [record] = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record?.coverImage).toMatchObject({ id: 11 });
    expect(record).not.toHaveProperty('bannerImage');
  });

  it('keeps the cover when there is one', async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: image(10, 1), bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record?.coverImage).toMatchObject({ id: 10 });
  });

  it('leaves out a banner-only article whose banner awaits review', async () => {
    const records = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: image(11, 1, 'minor') })],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });

  it('still leaves out an article with neither', async () => {
    const records = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: null })],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });

  it.each(['Pending', 'Error'])(
    'indexes an article with a %s cover without it; the banner stands in when servable',
    async (state) => {
      const cover = { ...image(10, 1), ingestion: state };
      const withBanner = await recordsOf({
        articles: [article({ coverImage: cover, bannerImage: image(11, 1) })],
        cosmetics: {},
      });
      expect(withBanner[0]?.coverImage).toMatchObject({ id: 11 });

      const coverOnly = await recordsOf({
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
    const records = await recordsOf({
      articles: [
        article({ coverImage: cover, bannerImage: image(11, 1) }),
        article({ coverImage: cover, bannerImage: null }),
      ],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });

  it("deletes an indexed article's document once its cover is blocked or under review", async () => {
    // An Update re-pulls an article already in the index; upserting the rest would leave its old
    // document, cover included, in place.
    const blocked = {
      ...article({ coverImage: { ...image(10, 1), needsReview: 'minor' }, bannerImage: null }),
      id: 7,
    };
    const pending = {
      ...article({ coverImage: { ...image(12, 1), ingestion: 'Pending' }, bannerImage: null }),
      id: 8,
    };
    const data = await transformData({ articles: [blocked, pending] as never, cosmetics: {} });

    expect(data.disqualifiedIds).toEqual([7]);
    await pushData({ indexName: 'articles' }, data);

    expect(meili.cleanup).toHaveBeenCalledWith({ indexName: 'articles', ids: [7] });
    const sent = meili.updateDocs.mock.calls[0][0].documents as {
      id: number;
      coverImage?: unknown;
    }[];
    // The pending one overwrites its old document without the cover.
    expect(sent.map((d) => [d.id, d.coverImage])).toEqual([[8, undefined]]);
  });
});
