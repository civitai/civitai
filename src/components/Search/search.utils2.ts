import type { TransformItemsMetadata } from 'instantsearch.js';
import { useHits, useInfiniteHits } from 'react-instantsearch';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { BountySearchIndexRecord } from '~/server/search-index/bounties.search-index';
import { CollectionSearchIndexRecord } from '~/server/search-index/collections.search-index';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';
import {
  ARTICLES_SEARCH_INDEX,
  BOUNTIES_SEARCH_INDEX,
  COLLECTIONS_SEARCH_INDEX,
  IMAGES_SEARCH_INDEX,
  MODELS_SEARCH_INDEX,
  USERS_SEARCH_INDEX,
} from '~/server/common/constants';

type DataKey = keyof DataIndex;
type DataIndex = {
  models: ModelSearchIndexRecord[];
  images: ImageSearchIndexRecord[];
  articles: ArticleSearchIndexRecord[];
  users: UserSearchIndexRecord[];
  collections: CollectionSearchIndexRecord[];
  bounties: BountySearchIndexRecord[];
};

type SearchIndexKey = keyof typeof SearchIndexMap;
const SearchIndexMap = {
  [MODELS_SEARCH_INDEX]: 'models',
  [IMAGES_SEARCH_INDEX]: 'images',
  [ARTICLES_SEARCH_INDEX]: 'articles',
  [USERS_SEARCH_INDEX]: 'users',
  [COLLECTIONS_SEARCH_INDEX]: 'collections',
  [BOUNTIES_SEARCH_INDEX]: 'bounties',
} as const;

function transformItems(items: any[], metadata: TransformItemsMetadata) {
  if (!metadata.results) return [];
  const index = metadata.results.index as SearchIndexKey;
  const type = SearchIndexMap[index];
  switch (type) {
    case 'models':
      return (items as ModelSearchIndexRecord[]).map((item) => ({
        ...item,
        tags: item.tags.map((t) => t.id),
        images: item.images.map((image) => ({
          ...image,
          tags: image.tags?.map((t) => t.id),
        })),
      }));
    case 'images':
      return (items as ImageSearchIndexRecord[]).map((item) => ({
        ...item,
        tags: item.tags?.map((t) => t.id),
      }));
    case 'articles':
      const test = type;
      return items as DataIndex[typeof type][];
    case 'bounties':
      return items as BountySearchIndexRecord[];
    case 'collections':
      return items as CollectionSearchIndexRecord[];
    case 'users':
      return items as UserSearchIndexRecord[];
    default:
      throw new Error('searchIndex transformItems not mapped');
  }
}

export function useTransformedHits() {
  return useHits({ transformItems });
}

export function useTransformedInfiniteHits() {
  return useInfiniteHits({ transformItems });
}

// export function useApplyHiddenPreferences<T>({
//   type,
//   data,
// }: {
//   type: FilterableDataType;
//   data: T[];
// }): T[] {
//   const currentUser = useCurrentUser();
//   const {
//     models: hiddenModels,
//     images: hiddenImages,
//     tags: hiddenTags,
//     users: hiddenUsers,
//     isLoading: loadingPreferences,
//   } = useHiddenPreferencesContext();

//   return useMemo(() => {
//     if (loadingPreferences) return [];
//     const opts = {
//       currentUserId: currentUser?.id,
//       hiddenImages,
//       hiddenTags,
//       hiddenUsers,
//       hiddenModels,
//     };
//     switch (type) {
//       case 'models':
//         return applyUserPreferencesModels({ ...opts, items: data });
//       case 'images':
//         return applyUserPreferencesImages({ ...opts, items: data });
//       case 'articles':
//         return applyUserPreferencesArticles({ ...opts, items: data });
//       case 'bounties':
//         return applyUserPreferencesBounties({ ...opts, items: data });
//       case 'collections':
//         return applyUserPreferencesCollections({ ...opts, items: data });
//       case 'users':
//         return applyUserPreferencesUsers({ ...opts, items: data });
//       default:
//         return [];
//     }
//   }, [type, hiddenModels, hiddenImages, hiddenTags, hiddenUsers, data, loadingPreferences]);
// }
