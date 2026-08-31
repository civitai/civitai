import { describe, expect, it } from 'vitest';
import {
  articleCollectionSortOptions,
  contestArticleSorts,
  contestModelSorts,
  contestPostSorts,
  imageCollectionSortOptions,
  modelCollectionSortOptions,
  postCollectionSortOptions,
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

// `Recently Added` orders on CollectionItem.id, and every service throws a 400 when it
// arrives without a collectionId. Two things therefore have to stay true together, and
// each is broken by a different half-finished edit: the general feed menus must not offer
// it (a `*SortHidden` entry that was never added), and the collection menus must
// (a `*CollectionSortOptions` list that was never extended).
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
  it.each(feeds)('$name withholds Recently Added from the general feed menu', (feed) => {
    // `SortFilter`'s `sortOptions` is `all` minus `hidden`; assert on that difference
    // rather than on the map, so dropping the filter there is caught too.
    const generalMenu = feed.all.filter((x) => !feed.hidden.includes(x as never));
    expect(generalMenu).not.toContain(feed.recentlyAdded);
  });

  it.each(feeds)('$name offers Recently Added first inside a collection', (feed) => {
    expect(feed.collectionOptions[0]).toBe(feed.recentlyAdded);
  });

  it.each(feeds)('$name collection menu still offers every general sort', (feed) => {
    const generalMenu = feed.all.filter((x) => !feed.hidden.includes(x as never));
    // Images are the exception: that menu was already an explicit two-sort subset
    // before this sort existed, so it is asserted on its own below.
    if (feed.name === 'images') return;
    for (const sort of generalMenu) expect(feed.collectionOptions).toContain(sort);
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
  // A contest re-rolls its sort every render. Recently Added is deterministic, so a draw
  // landing on it pins the newest entries to the top — the visibility spread the rotation
  // exists for is gone for that render, and nothing about the feed looks wrong.
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
