import { flagifyBrowsingLevel } from '~/shared/constants/browsingLevel.constants';
import type { Hit, TransformItemsMetadata } from 'instantsearch.js';
import { useHits, useInfiniteHits } from 'react-instantsearch';
import { ArticleSearchIndexRecord } from '~/server/search-index/articles.search-index';
import { BountySearchIndexRecord } from '~/server/search-index/bounties.search-index';
import { CollectionSearchIndexRecord } from '~/server/search-index/collections.search-index';
import { ImageSearchIndexRecord } from '~/server/search-index/images.search-index';
import { ModelSearchIndexRecord } from '~/server/search-index/models.search-index';
import { UserSearchIndexRecord } from '~/server/search-index/users.search-index';

import { ImageIngestionStatus } from '@prisma/client';
import { ReverseSearchIndexKey, reverseSearchIndexMap } from '~/components/Search/search.types';

// #region [transformers]
type ModelsTransformed = ReturnType<typeof modelsTransform>;
function modelsTransform(items: Hit<ModelSearchIndexRecord>[]) {
  return items.map((item) => ({
    ...item,
    nsfwLevel: flagifyBrowsingLevel(item.nsfwLevel),
    tags: item.tags.map((t) => t.id),
    images:
      item.images?.map((image) => ({
        ...image,
        tags: image.tags?.map((t) => t.id),
      })) ?? [],
  }));
}

type ImagesTransformed = ReturnType<typeof imagesTransform>;
function imagesTransform(items: Hit<ImageSearchIndexRecord>[]) {
  return items.map((item) => ({
    ...item,
    nsfwLevel: flagifyBrowsingLevel(item.nsfwLevel),
    ingestion: ImageIngestionStatus.Scanned,
  }));
}

type ArticlesTransformed = ReturnType<typeof articlesTransform>;
function articlesTransform(items: Hit<ArticleSearchIndexRecord>[]) {
  return items.map((article) => ({
    ...article,
    nsfwLevel: flagifyBrowsingLevel(article.nsfwLevel),
    coverImage: { ...article.coverImage, tags: article.coverImage.tags.map((x) => x.id) },
  }));
}

type BountiesTransformed = ReturnType<typeof bountiesTransform>;
function bountiesTransform(items: Hit<BountySearchIndexRecord>[]) {
  return items.map((bounty) => ({
    ...bounty,
    nsfwLevel: flagifyBrowsingLevel(bounty.nsfwLevel),
    tags: bounty.tags.map((x) => x.id),
    images: bounty.images.map((image) => ({ ...image, tagIds: image.tags.map((x) => x.id) })),
  }));
}

type CollectionsTransformed = ReturnType<typeof collectionsTransform>;
function collectionsTransform(items: Hit<CollectionSearchIndexRecord>[]) {
  return items.map((collection) => ({
    ...collection,
    nsfwLevel: flagifyBrowsingLevel(collection.nsfwLevel),
    userId: collection.user.id,
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

type IndexName = keyof SearchIndexDataMap;
export type SearchIndexDataMap = {
  models: ModelsTransformed;
  images: ImagesTransformed;
  articles: ArticlesTransformed;
  users: UsersTransformed;
  collections: CollectionsTransformed;
  bounties: BountiesTransformed;
};
// type IndexName = keyof typeof searchIndexTransformMap;
// export type SearchIndexDataTransformType<T extends IndexName> = ReturnType<
//   (typeof searchIndexTransformMap)[T]
// >[number];
const searchIndexTransformMap = {
  models: modelsTransform,
  images: imagesTransform,
  articles: articlesTransform,
  users: usersTransform,
  collections: collectionsTransform,
  bounties: bountiesTransform,
};
// #endregion

const transformItems = (items: any[], metadata: TransformItemsMetadata) => {
  if (!metadata.results?.nbHits) return [];
  const index = metadata.results.index as ReverseSearchIndexKey;
  const type = reverseSearchIndexMap[index];
  const transformFn = searchIndexTransformMap[type];
  if (!type) throw new Error(`type does not exist on searchIndexTransformMap: ${type}`);
  return transformFn(items);
};

export function useHitsTransformed<T extends IndexName>() {
  return useHits<SearchIndexDataMap[T][number]>({
    transformItems,
  });
}

export function useInfiniteHitsTransformed<T extends IndexName>() {
  return useInfiniteHits<SearchIndexDataMap[T][number]>({
    transformItems,
  });
}
