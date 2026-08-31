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

const visible = <T extends string>(all: T[], hidden: Record<string, T>) =>
  all.filter((x) => !Object.values(hidden).includes(x));

// `Recently Added` orders by CollectionItem.id, so it is meaningless — and rejected by the
// services — outside a collection. It is held out of every feed's menu via the `*SortHidden`
// maps and added back here, which is the only place a collectionId is guaranteed.
export const imageCollectionSortOptions = [
  ImageSort.RecentlyAdded,
  ImageSort.Newest,
  ImageSort.Oldest,
];

export const modelCollectionSortOptions = [
  ModelSort.RecentlyAdded,
  ...visible(Object.values(ModelSort), ModelSortHidden),
];

export const postCollectionSortOptions = [
  PostSort.RecentlyAdded,
  ...visible(Object.values(PostSort), PostSortHidden),
];

export const articleCollectionSortOptions = [
  ArticleSort.RecentlyAdded,
  ...visible(Object.values(ArticleSort), ArticleSortHidden),
];

export const toSortMenuOptions = <T extends string>(options: T[]) =>
  options.map((value) => ({ label: value, value }));

// A contest feed re-rolls its sort on every render to spread entry visibility, so the pool must
// hold only sorts that shuffle. `Recently Added` is deterministic and would pin the newest entries
// to the top for whichever renders draw it — the same reason Oldest is held out of the post pool.
export const contestModelSorts = visible(Object.values(ModelSort), ModelSortHidden);
export const contestArticleSorts = visible(Object.values(ArticleSort), ArticleSortHidden);
export const contestPostSorts = visible(Object.values(PostSort), PostSortHidden).filter(
  (sort) => sort !== PostSort.Oldest
);
