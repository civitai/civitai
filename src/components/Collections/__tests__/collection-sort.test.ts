import { describe, expect, it } from 'vitest';
import {
  articleCollectionSortOptions,
  contestArticleSorts,
  contestModelSorts,
  contestPostSorts,
  imageCollectionSortOptions,
  modelCollectionSortOptions,
  postCollectionSortOptions,
  resolveImageCollectionSort,
} from '~/components/Collections/collection-sort';
import {
  ArticleSort,
  ArticleSortHidden,
  ImageSort,
  ImageSortHidden,
  ModelSort,
  ModelSortHidden,
  PostSort,
  PostSortHidden,
} from '~/server/common/enums';

// Every service 400s `Recently Added` when it arrives without a collectionId, so the general
// menus must never offer it and the collection menus must.
const feeds = [
  {
    name: 'images',
    all: Object.values(ImageSort),
    hidden: Object.values(ImageSortHidden),
    collectionOptions: imageCollectionSortOptions,
    recentlyAdded: ImageSort.RecentlyAdded,
  },
  {
    name: 'models',
    all: Object.values(ModelSort),
    hidden: Object.values(ModelSortHidden),
    collectionOptions: modelCollectionSortOptions,
    recentlyAdded: ModelSort.RecentlyAdded,
  },
  {
    name: 'posts',
    all: Object.values(PostSort),
    hidden: Object.values(PostSortHidden),
    collectionOptions: postCollectionSortOptions,
    recentlyAdded: PostSort.RecentlyAdded,
  },
  {
    name: 'articles',
    all: Object.values(ArticleSort),
    hidden: Object.values(ArticleSortHidden),
    collectionOptions: articleCollectionSortOptions,
    recentlyAdded: ArticleSort.RecentlyAdded,
  },
] as const;

describe('collection sort options', () => {
  // SortFilter's `sortOptions` map is module-private, so this asserts the input it
  // subtracts — a dropped `.filter` there is not covered.
  it.each(feeds)(
    '$name hides Recently Added from the general feed menu via *SortHidden',
    (feed) => {
      expect(feed.hidden).toContain(feed.recentlyAdded);
    }
  );

  it.each(feeds)('$name offers Recently Added first inside a collection', (feed) => {
    expect(feed.collectionOptions[0]).toBe(feed.recentlyAdded);
  });

  // The image collection menu was a deliberate two-sort subset before this sort existed;
  // it is asserted exactly, below.
  it.each(feeds.filter((f) => f.name !== 'images'))(
    '$name collection menu still offers every general sort',
    (feed) => {
      const generalMenu = feed.all.filter((x) => !feed.hidden.includes(x as never));
      for (const sort of generalMenu) expect(feed.collectionOptions).toContain(sort);
    }
  );

  // The one behaviour the feature exists for: a viewer who asks for nothing gets add order.
  // Only images default to it — models, posts and articles keep Newest.
  it('defaults an image collection to Recently Added', () => {
    expect(resolveImageCollectionSort({})).toBe(ImageSort.RecentlyAdded);
  });

  it('lets the URL override the default, but only with a sort this menu serves', () => {
    expect(resolveImageCollectionSort({ querySort: ImageSort.Oldest })).toBe(ImageSort.Oldest);
    // MostReactions is a real ImageSort the collection menu does not offer, so it falls back
    // rather than reaching a service that would order on a column the CTE never selected.
    expect(resolveImageCollectionSort({ querySort: ImageSort.MostReactions })).toBe(
      ImageSort.RecentlyAdded
    );
  });

  it('gives a contest collection Random, whatever the URL says', () => {
    expect(resolveImageCollectionSort({ isContest: true })).toBe(ImageSort.Random);
    expect(resolveImageCollectionSort({ querySort: ImageSort.Newest, isContest: true })).toBe(
      ImageSort.Random
    );
  });

  it('keeps the image collection menu to the three sorts it can serve', () => {
    expect(imageCollectionSortOptions).toEqual([
      ImageSort.RecentlyAdded,
      ImageSort.Newest,
      ImageSort.Oldest,
    ]);
  });
});

describe('contest sort pools', () => {
  // Nothing here filters Recently Added explicitly — it is out of the pools only because
  // `visible()` drops `*SortHidden`, so removing it from those maps re-admits it silently.
  it.each([
    { name: 'models', pool: contestModelSorts as readonly string[], sort: ModelSort.RecentlyAdded },
    { name: 'posts', pool: contestPostSorts as readonly string[], sort: PostSort.RecentlyAdded },
    {
      name: 'articles',
      pool: contestArticleSorts as readonly string[],
      sort: ArticleSort.RecentlyAdded,
    },
  ])('$name pool cannot draw Recently Added', ({ pool, sort }) => {
    expect(pool.length).toBeGreaterThan(0);
    expect(pool).not.toContain(sort);
  });

  it('post pool still withholds Oldest', () => {
    expect(contestPostSorts).not.toContain(PostSort.Oldest);
  });
});
