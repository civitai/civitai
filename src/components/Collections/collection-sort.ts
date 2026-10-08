import {
  ArticleSort,
  ArticleSortHidden,
  ImageSort,
  ImageSortHidden,
  ModelSort,
  PostSort,
  PostSortHidden,
} from '~/server/common/enums';

const visible = <T extends string>(all: T[], hidden: Record<string, T>) =>
  all.filter((x) => !Object.values(hidden).includes(x));

// `Recently Added` orders on CollectionItem.id, so every service 400s it without a
// collectionId. That is why it lives in `*SortHidden` and is added back only here.
export const imageCollectionSortOptions = [
  ImageSort.RecentlyAdded,
  ImageSort.Newest,
  ImageSort.Oldest,
];

// Listed, not spread: Hot is a browse-discovery sort. In a collection, or a contest feed
// that re-rolls its sort, it would change which entries get seen. Hiding it via the
// hidden-sorts map is not the answer either — that removes it from the feed menu too.
export const modelCollectionSortOptions = [
  ModelSort.RecentlyAdded,
  ModelSort.HighestRated,
  ModelSort.MostDownloaded,
  ModelSort.MostLiked,
  ModelSort.MostDiscussed,
  ModelSort.MostCollected,
  ModelSort.ImageCount,
  ModelSort.Newest,
  ModelSort.Oldest,
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

/**
 * A contest re-rolls at random. Otherwise the URL wins only when it names one of this menu's
 * sorts: the ImageSorts left out order on columns the collection query never selects.
 */
export const resolveImageCollectionSort = ({
  querySort,
  isContest,
}: {
  querySort?: ImageSort;
  isContest?: boolean;
}): ImageSort => {
  if (isContest) return ImageSort.Random;
  return querySort && imageCollectionSortOptions.includes(querySort) ? querySort : ImageSort.Newest;
};

export const contestModelSorts = modelCollectionSortOptions.filter(
  (sort) => sort !== ModelSort.RecentlyAdded
);
export const contestArticleSorts = visible(Object.values(ArticleSort), ArticleSortHidden);
// Contest feeds re-roll their sort each render to spread entry visibility, and Oldest is the
// only ascending post sort: a roll landing on it pins the earliest submissions to the top for
// that render.
export const contestPostSorts = visible(Object.values(PostSort), PostSortHidden).filter(
  (sort) => sort !== PostSort.Oldest
);
