import { isEqual } from 'lodash-es';
import { useRouter } from 'next/router';
import { useEffect, useRef } from 'react';
import type * as z from 'zod';
import { articleQueryParamSchema } from '~/components/Article/article.utils';
import { imagesQueryParamSchema } from '~/components/Image/image-query-params';
import { modelQueryParamSchema } from '~/components/Model/model.utils';
import { postQueryParamSchema } from '~/components/Post/post.utils';
import { useFiltersContext, useSetFilters } from '~/providers/FiltersProvider';

export type CollectionFeedType = 'models' | 'images' | 'posts' | 'articles';
type QueryValue = string | string[];
type RememberedQuery = Record<string, QueryValue>;

const storeKeys = {
  models: 'collectionModels',
  images: 'collectionImages',
  posts: 'collectionPosts',
  articles: 'collectionArticles',
} as const;

const schemas: Record<CollectionFeedType, z.ZodObject> = {
  models: modelQueryParamSchema,
  images: imagesQueryParamSchema,
  posts: postQueryParamSchema,
  articles: articleQueryParamSchema,
};

// Never the collection's own id, its category tag, or the per-viewer views (followed, hidden, ...).
const rememberedKeys: Record<CollectionFeedType, readonly string[]> = {
  models: [
    'sort',
    'period',
    'periodMode',
    'publishedFrom',
    'publishedTo',
    'types',
    'checkpointType',
    'baseModels',
    'status',
    'fileFormats',
    'availability',
    'supportsGeneration',
    'earlyAccess',
    'paidAccess',
    'hidePaid',
    'onSale',
    'fromPlatform',
    'isFeatured',
  ],
  images: [
    'sort',
    'period',
    'periodMode',
    'types',
    'baseModels',
    'withMeta',
    'fromPlatform',
    'hideAutoResources',
    'hideManualResources',
    'tools',
    'techniques',
    'requiringMeta',
    'remixesOnly',
    'nonRemixesOnly',
    'hideChallenges',
  ],
  posts: ['sort', 'period'],
  articles: ['sort', 'period'],
};

export function pickRememberedQuery(
  type: CollectionFeedType,
  query: Record<string, unknown>
): RememberedQuery {
  const picked: RememberedQuery = {};
  for (const key of rememberedKeys[type]) {
    const value = query[key];
    if (
      typeof value === 'string' ||
      (Array.isArray(value) && value.every((v) => typeof v === 'string'))
    )
      picked[key] = value;
  }
  return picked;
}

/** Drops each remembered value its schema no longer accepts, so one stale value costs only itself. */
export function validRememberedQuery(
  type: CollectionFeedType,
  stored: RememberedQuery | undefined
) {
  const shape = schemas[type].shape as Record<string, z.ZodType>;
  const valid: RememberedQuery = {};
  for (const [key, value] of Object.entries(stored ?? {})) {
    if (!rememberedKeys[type].includes(key)) continue;
    if (shape[key]?.safeParse(value).success) valid[key] = value;
  }
  return valid;
}

/**
 * Keeps a collection's sort and filters across collections of the same content type. The URL is the
 * truth; a collection opened without any of them takes the remembered ones once, and from then on
 * the store follows the URL. Contest collections force their own filters and stay out of it.
 */
export function useRememberCollectionFilters({
  type,
  collectionId,
  isContest,
}: {
  type: CollectionFeedType;
  collectionId: number;
  isContest: boolean;
}) {
  const router = useRouter();
  const stored = useFiltersContext((state) => state[storeKeys[type]]);
  const setStored = useSetFilters(storeKeys[type]);

  const storedRef = useRef(stored.query);
  storedRef.current = stored.query;
  const seededFor = useRef<number | null>(null);

  const inUrl = pickRememberedQuery(type, router.query);
  const urlSignature = JSON.stringify(inUrl);

  useEffect(() => {
    // The collection and the address change in separate renders; acting between them would read one
    // collection's filters off the other's address.
    if (isContest || !router.isReady || String(router.query.collectionId) !== String(collectionId))
      return;

    if (seededFor.current !== collectionId) {
      seededFor.current = collectionId;
      const seed = validRememberedQuery(type, storedRef.current);
      if (!Object.keys(inUrl).length && Object.keys(seed).length) {
        router.replace(
          { pathname: router.pathname, query: { ...router.query, ...seed } },
          undefined,
          {
            shallow: true,
            scroll: false,
          }
        );
        return;
      }
    }

    if (!isEqual(storedRef.current ?? {}, inUrl)) setStored({ query: inUrl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isContest, router.isReady, router.query.collectionId, collectionId, type, urlSignature]);
}
