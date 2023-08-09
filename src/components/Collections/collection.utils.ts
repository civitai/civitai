import { CollectionReadConfiguration } from '@prisma/client';
import { Icon, IconEyeOff, IconLock, IconWorld } from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { z } from 'zod';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { CollectionSort } from '~/server/common/enums';
import { GetAllCollectionsInfiniteSchema } from '~/server/schema/collection.schema';
import { CollectionItemExpanded } from '~/server/services/collection.service';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';

const collectionQueryParamSchema = z
  .object({
    collectionId: z
      .union([z.array(z.coerce.number()), z.coerce.number()])
      .transform((val) => (Array.isArray(val) ? val[0] : val)),
    sort: z.nativeEnum(CollectionSort),
    userId: z.coerce.number().optional(),
  })
  .partial();

export const useCollectionFilters = () => {
  const storeFilters = useFiltersContext((state) => state.collections);
  return removeEmpty(storeFilters);
};

export type CollectionQueryParams = z.output<typeof collectionQueryParamSchema>;
export const useCollectionQueryParams = () => {
  const { query, pathname, push } = useRouter();

  return useMemo(() => {
    const result = collectionQueryParamSchema.safeParse(query);
    const data: CollectionQueryParams = result.success ? result.data : {};

    return {
      ...data,
      set: (filters: Partial<CollectionQueryParams>, pathnameOverride?: string) => {
        push(
          {
            pathname: pathnameOverride ?? pathname,
            query: removeEmpty({ ...query, ...filters }),
          },
          undefined,
          {
            shallow: !pathnameOverride || pathname === pathnameOverride,
          }
        );
      },
    };
  }, [query, pathname, push]);
};

export const getCollectionItemReviewData = (collectionItem: CollectionItemExpanded) => {
  switch (collectionItem.type) {
    case 'image': {
      return {
        type: collectionItem.type,
        image: collectionItem.data,
        meta: collectionItem.data.meta
          ? {
              ...collectionItem.data.meta,
              generationProcess: collectionItem.data.generationProcess,
            }
          : null,
        user: collectionItem.data.user,
        url: `/images/${collectionItem.data.id}`,
        baseModel: collectionItem.data.baseModel,
      };
    }
    case 'model': {
      return {
        type: collectionItem.type,
        image: collectionItem.data.image,
        user: collectionItem.data.user,
        url: `/models/${collectionItem.data.id}`,
      };
    }
    case 'post': {
      return {
        type: collectionItem.type,
        image: collectionItem.data.image,
        user: collectionItem.data.user,
        url: `/posts/${collectionItem.data.id}`,
      };
    }
    case 'article': {
      return {
        type: collectionItem.type,
        cover: collectionItem.data.cover,
        user: collectionItem.data.user,
        title: collectionItem.data.title,
        url: `/articles/${collectionItem.data.id}`,
      };
    }
    default:
      throw new Error('unsupported collection type');
  }
};
export const useQueryCollections = (
  filters?: Partial<GetAllCollectionsInfiniteSchema>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingMode = useFiltersContext((state) => state.browsingMode);
  const { data, ...rest } = trpc.collection.getInfinite.useInfiniteQuery(
    { ...filters, browsingMode },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const collections = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, collections, ...rest };
};

export type PrivacyData = {
  icon: Icon;
  value: string;
  label: string;
  description: string;
};
export const collectionReadPrivacyData: Record<CollectionReadConfiguration, PrivacyData> = {
  [CollectionReadConfiguration.Private]: {
    icon: IconLock,
    label: 'Private',
    value: CollectionReadConfiguration.Private,
    description: 'Only you and contributors for this collection can see this',
  },
  [CollectionReadConfiguration.Public]: {
    icon: IconWorld,
    label: 'Public',
    value: CollectionReadConfiguration.Public,
    description: 'Anyone can see this collection',
  },
  [CollectionReadConfiguration.Unlisted]: {
    icon: IconEyeOff,
    label: 'Unlisted',
    value: CollectionReadConfiguration.Unlisted,
    description: 'Only people with the link can see this collection',
  },
};
