import {
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '@prisma/client';
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
import { CollectionByIdModel } from '~/types/router';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';

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
        itemAddedAt: collectionItem.createdAt,
        dataCreatedAt: collectionItem.data.createdAt,
      };
    }
    case 'model': {
      return {
        type: collectionItem.type,
        image: collectionItem.data.images?.[0], // TODO.frontend filters
        user: collectionItem.data.user,
        url: `/models/${collectionItem.data.id}`,
        itemAddedAt: collectionItem.createdAt,
        dataCreatedAt: collectionItem.data.createdAt,
      };
    }
    case 'post': {
      return {
        type: collectionItem.type,
        image: collectionItem.data.images[0],
        user: collectionItem.data.user,
        url: `/posts/${collectionItem.data.id}`,
        itemAddedAt: collectionItem.createdAt,
      };
    }
    case 'article': {
      return {
        type: collectionItem.type,
        image: collectionItem.data.coverImage,
        user: collectionItem.data.user,
        title: collectionItem.data.title,
        url: `/articles/${collectionItem.data.id}`,
        itemAddedAt: collectionItem.createdAt,
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

  const { data, isLoading, ...rest } = trpc.collection.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items: collections, loadingPreferences } = useApplyHiddenPreferences({
    type: 'collections',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  return { data, collections, isLoading: isLoading || loadingPreferences, ...rest };
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

export const collectionWritePrivacyData: Record<CollectionWriteConfiguration, PrivacyData> = {
  [CollectionWriteConfiguration.Private]: {
    icon: IconLock,
    label: 'Private - only the owner can add content',
    value: CollectionWriteConfiguration.Private,
    description: 'No one will be able to add content to this collection',
  },
  [CollectionWriteConfiguration.Public]: {
    icon: IconWorld,
    label: 'Public - No review required',
    value: CollectionWriteConfiguration.Public,
    description: 'Anyone can add content to this collection. No review required.',
  },
  [CollectionWriteConfiguration.Review]: {
    icon: IconEyeOff,
    label: 'Public - Review required',
    value: CollectionWriteConfiguration.Review,
    description:
      'Anyone can add content to this collection, but content needs to be reviewed before it is visible.',
  },
};

export const isCollectionSubsmissionPeriod = (collection?: CollectionByIdModel) => {
  if (!collection) {
    return false;
  }

  const metadata = collection?.metadata ?? {};

  if (!metadata.submissionStartDate || !metadata.submissionEndDate) return false;

  return (
    metadata.submissionStartDate &&
    metadata.submissionEndDate &&
    new Date(metadata.submissionStartDate) < new Date() &&
    new Date(metadata.submissionEndDate) > new Date()
  );
};

export const useSystemCollections = () => {
  const currentUser = useCurrentUser();
  const { data: systemCollections = [], ...other } = trpc.user.getBookmarkCollections.useQuery(
    undefined,
    { enabled: !!currentUser }
  );

  const groupedCollections = useMemo(() => {
    const grouped = systemCollections.reduce((acc, collection) => {
      if (collection.type) acc[collection.type] = collection;
      return acc;
    }, {} as Record<CollectionType, (typeof systemCollections)[number]>);

    return grouped;
  }, [systemCollections]);

  return {
    ...other,
    systemCollections,
    groupedCollections,
  };
};
