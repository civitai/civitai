import type { Hit, TransformItems, TransformItemsMetadata } from 'instantsearch.js';
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
import { ImageIngestionStatus } from '@prisma/client';
import type { InfiniteHitsRenderState } from 'instantsearch.js/es/connectors/infinite-hits/connectInfiniteHits';

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

// #region [transformers]
type ModelsTransformed = ReturnType<typeof modelsTransform>;
function modelsTransform(items: Hit<ModelSearchIndexRecord>[]) {
  return items.map((item) => ({
    ...item,
    tags: item.tags.map((t) => t.id),
    images: item.images.map((image) => ({
      ...image,
      tags: image.tags?.map((t) => t.id),
    })),
  }));
}

type ImagesTransformed = ReturnType<typeof imagesTransform>;
function imagesTransform(items: Hit<ImageSearchIndexRecord>[]) {
  return items.map((item) => ({
    ...item,
    tagIds: item.tags?.map((t) => t.id),
    ingestion: ImageIngestionStatus.Scanned,
  }));
}

type ArticlesTransformed = ReturnType<typeof articlesTransform>;
function articlesTransform(items: Hit<ArticleSearchIndexRecord>[]) {
  return items.map((article) => ({ ...article }));
}

type BountiesTransformed = ReturnType<typeof bountiesTransform>;
function bountiesTransform(items: Hit<BountySearchIndexRecord>[]) {
  return items.map((bounty) => ({
    ...bounty,
    tags: bounty.tags.map((x) => x.id),
    images: bounty.images.map((image) => ({ ...image, tagIds: image.tags.map((x) => x.id) })),
  }));
}

type CollectionsTransformed = ReturnType<typeof collectionsTransform>;
function collectionsTransform(items: Hit<CollectionSearchIndexRecord>[]) {
  return items.map((collection) => ({
    ...collection,
    image: collection.image
      ? {
          ...collection.image,
          tagIds: collection.image?.tags.map((x) => x.id),
        }
      : null,
    images: collection.images.map((image) => ({
      ...image,
      tagIds: image.tags.map((x) => x.id),
    })),
  }));
}

type UsersTransformed = ReturnType<typeof usersTransform>;
function usersTransform(items: Hit<UserSearchIndexRecord>[]) {
  return items;
}

type IndexName = keyof TransformationMap;
type TransformationMap = {
  models: ModelsTransformed;
  images: ImagesTransformed;
  articles: ArticlesTransformed;
  users: UsersTransformed;
  collections: CollectionsTransformed;
  bounties: BountiesTransformed;
};
// #endregion

const transformItems = (items: any[], metadata: TransformItemsMetadata) => {
  if (!metadata.results) return [];
  const index = metadata.results.index as SearchIndexKey;
  const type = SearchIndexMap[index];
  switch (type) {
    case 'models':
      return modelsTransform(items);
    case 'images':
      return imagesTransform(items);
    case 'articles':
      return articlesTransform(items);
    case 'bounties':
      return bountiesTransform(items);
    case 'collections':
      return collectionsTransform(items);
    case 'users':
      return usersTransform(items);
    default:
      throw new Error('searchIndex transformItems not mapped');
  }
};

export function useHitsTransformed<T extends IndexName>() {
  return useHits<TransformationMap[T][number]>({
    transformItems,
  });
}

export function useInfiniteHitsTransformed<T extends IndexName>() {
  return useInfiniteHits<TransformationMap[T][number]>({
    transformItems,
  });
}
