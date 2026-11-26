import { Prisma } from '@prisma/client';
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

import {
  articleSelect,
  getIndexWithheldImageIds,
  pushData,
  transformData,
} from '~/server/search-index/articles.search-index';

type Input = Parameters<typeof transformData>[0];
const recordsOf = async (input: Input) => (await transformData(input)).records;

const image = (id: number, nsfwLevel: number, needsReview: string | null = null) => ({
  id,
  url: `key-${id}`,
  nsfwLevel,
  ingestion: 'Scanned',
  needsReview,
  modelRestricted: false,
  meta: null,
  tags: [],
});

const article = (images: { coverImage: unknown; bannerImage: unknown; cover?: string }) =>
  ({
    id: 1,
    nsfwLevel: 1,
    content: '<p>Hi</p>',
    tags: [],
    stats: null,
    user: { id: 7, username: 'author', image: 'legacy-avatar.png', profilePicture: { id: 70 } },
    ...images,
  } as unknown as Input['articles'][number]);

describe('articles search index', () => {
  it("indexes the author's profile picture but not the legacy image", async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: image(10, 1), bannerImage: null })],
      cosmetics: {},
    });
    expect(record?.user).toEqual({
      id: 7,
      username: 'author',
      image: null,
      profilePicture: { id: 70 },
    });
  });

  it('indexes a banner-only article with its banner as the card image', async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record?.coverImage).toMatchObject({ id: 11 });
    expect(record).not.toHaveProperty('bannerImage');
  });

  it('🔴 indexes an article without a cover its model withholds, and not with its banner', async () => {
    meili.updateDocs.mockClear();
    const data = await transformData({
      articles: [article({ coverImage: image(10, 1), bannerImage: image(11, 1) })],
      cosmetics: {},
      withheldImageIds: new Set([10]),
    });
    await pushData({ indexName: 'articles' }, data);
    const [sent] = meili.updateDocs.mock.calls[0][0].documents as Record<string, unknown>[];
    // The key must be present: the index update merges, and an absent key keeps the stored cover.
    expect(sent).toHaveProperty('coverImage', null);
  });

  it('indexes a banner-only article without a banner its model withholds', async () => {
    const records = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: image(11, 1) })],
      cosmetics: {},
      withheldImageIds: new Set([11]),
    });
    expect(records).toHaveLength(0);
  });

  const restricted = (id: number) => ({ ...image(id, 4), minor: true });

  // transformData takes fetched rows, so only the select shows the flag is read. Without it `minor`
  // is undefined, which the rule reads as unrestricted: the cover would be indexed for everyone.
  it('reads the flag for the cover and the banner', () => {
    expect(articleSelect.coverImage.select.minor).toBe(true);
    expect(articleSelect.bannerImage.select.minor).toBe(true);
  });

  it('🔴 indexes an article without a restricted minor cover, and not with its banner', async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: restricted(10), bannerImage: image(11, 1) })],
      cosmetics: {},
    });
    expect(record).toBeDefined();
    expect(record?.coverImage).toBeUndefined();
  });

  it('🔴 clears the legacy cover key of an article whose cover is a restricted minor image', async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: restricted(10), bannerImage: null, cover: 'key-10' })],
      cosmetics: {},
    });
    expect(record).toHaveProperty('cover', null);
  });

  it('🔴 indexes an article without a cover restricted by its base model, nor its banner, or its legacy key', async () => {
    const [record] = await recordsOf({
      articles: [
        article({
          coverImage: { ...image(10, 4), modelRestricted: true },
          bannerImage: image(11, 1),
          cover: 'key-10',
        }),
      ],
      cosmetics: {},
    });
    expect(record?.coverImage).toBeUndefined();
    expect(record).toHaveProperty('cover', null);
  });

  it('keeps the legacy cover key of an article whose cover is shown (control)', async () => {
    const [record] = await recordsOf({
      articles: [article({ coverImage: image(10, 4), bannerImage: null, cover: 'key-10' })],
      cosmetics: {},
    });
    expect(record).toHaveProperty('cover', 'key-10');
  });

  it('🔴 leaves out a banner-only article whose banner is a restricted minor image', async () => {
    const records = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: restricted(11) })],
      cosmetics: {},
    });
    expect(records).toHaveLength(0);
  });

  it('keeps a minor-flagged PG-13 cover and an unflagged R cover, without the flag (control)', async () => {
    for (const cover of [
      { ...image(10, 2), minor: true },
      { ...image(10, 4), minor: false },
    ]) {
      const [record] = await recordsOf({
        articles: [article({ coverImage: cover, bannerImage: null })],
        cosmetics: {},
      });
      expect(record?.coverImage).toMatchObject({ id: 10 });
      expect(record?.coverImage).not.toHaveProperty('minor');
    }
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
    meili.updateDocs.mockClear();
    await pushData({ indexName: 'articles' }, data);

    expect(meili.cleanup).toHaveBeenCalledWith({ indexName: 'articles', ids: [7] });
    const sent = meili.updateDocs.mock.calls[0][0].documents as {
      id: number;
      coverImage?: unknown;
    }[];
    // The pending one overwrites its old document's cover with null: the update merges.
    expect(sent.map((d) => [d.id, 'coverImage' in d, d.coverImage])).toEqual([[8, true, null]]);
  });
});

describe('the images the articles index withholds', () => {
  // Answers the report-listed lookup with `listed`, and the model lookup with `byModel`.
  const dbAnswering = ({ listed = [] as number[], byModel = [] as number[] }) =>
    ({
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = Prisma.sql(strings, ...(values as never[])).sql;
        return (sql.includes('"CsamReport"') ? listed : byModel).map((id) => ({ id }));
      },
    } as never);

  it('🔴 withholds a cover listed on a report, and does not fall back to the banner', async () => {
    const withheldImageIds = await getIndexWithheldImageIds(
      [10, 11],
      dbAnswering({ listed: [10] })
    );
    const [record] = await recordsOf({
      articles: [article({ coverImage: image(10, 1), bannerImage: image(11, 1) })],
      cosmetics: {},
      withheldImageIds,
    });
    expect(record).toHaveProperty('coverImage', undefined);
  });

  it('🔴 leaves out a banner-only article whose banner is listed on a report', async () => {
    const withheldImageIds = await getIndexWithheldImageIds([11], dbAnswering({ listed: [11] }));
    const records = await recordsOf({
      articles: [article({ coverImage: null, bannerImage: image(11, 1) })],
      cosmetics: {},
      withheldImageIds,
    });
    expect(records).toHaveLength(0);
  });

  it('withholds what its model withholds too, and nothing else (control)', async () => {
    const ids = await getIndexWithheldImageIds([10, 11, 12], dbAnswering({ byModel: [12] }));
    expect([...ids]).toEqual([12]);
  });
});
