import type { Icon } from '@tabler/icons-react';
import {
  IconCategory,
  IconEyeOff,
  IconFileText,
  IconLayoutList,
  IconLock,
  IconPhoto,
  IconWorld,
} from '@tabler/icons-react';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import * as z from 'zod';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { CollectionSort } from '~/server/common/enums';
import type {
  EnableCollectionYoutubeSupportInput,
  GetAllCollectionsInfiniteSchema,
  RemoveCollectionItemInput,
  SetCollectionItemNsfwLevelInput,
  SetItemScoreInput,
} from '~/server/schema/collection.schema';
import type { CollectionItemExpanded } from '~/server/services/collection.service';
import {
  CollectionMode,
  CollectionReadConfiguration,
  CollectionType,
  CollectionWriteConfiguration,
} from '~/shared/utils/prisma/enums';
import type { CollectionByIdModel } from '~/types/router';
import { isFutureDate } from '~/utils/date-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const collectionQueryParamSchema = z
  .object({
    collectionId: z
      .union([z.array(z.coerce.number()), z.coerce.number()])
      .transform((val) => (Array.isArray(val) ? val[0] : val)),
    sort: z.enum(CollectionSort),
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
        // meta: collectionItem.data.meta
        //   ? {
        //       ...collectionItem.data.meta,
        //       generationProcess: collectionItem.data.generationProcess,
        //     }
        //   : null,
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
        image: collectionItem.data.coverImage
          ? {
              ...collectionItem.data.coverImage,
              hasMeta:
                !collectionItem.data.coverImage.hideMeta && !!collectionItem.data.coverImage.meta,
              onSite: false,
            }
          : undefined,
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
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const excludedTagIds = [
    ...(filters.excludedTagIds ?? []),
    ...(browsingSettingsAddons.settings.excludedTagIds ?? []),
  ].filter(isDefined);

  const { data, isLoading, ...rest } = trpc.collection.getInfinite.useInfiniteQuery(
    { ...filters, excludedTagIds },
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

export type TypeData = {
  icon: Icon;
  label: string;
  value: string;
  color?: string;
};

export const collectionTypeData: Record<CollectionType, TypeData> = {
  [CollectionType.Model]: {
    icon: IconCategory,
    label: 'Model',
    value: CollectionType.Model,
    color: 'blue',
  },
  [CollectionType.Image]: {
    icon: IconPhoto,
    label: 'Image',
    value: CollectionType.Image,
    color: 'violet',
  },
  [CollectionType.Post]: {
    icon: IconLayoutList,
    label: 'Post',
    value: CollectionType.Post,
    color: 'green',
  },
  [CollectionType.Article]: {
    icon: IconFileText,
    label: 'Article',
    value: CollectionType.Article,
    color: 'orange',
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

export const useCollectionsForPostCreation = ({
  collectionIds = [],
}: {
  collectionIds?: number[];
}) => {
  const { data: collections = [], ...other } = trpc.collection.getPermissionDetails.useQuery(
    {
      ids: collectionIds,
    },
    {
      enabled: collectionIds?.length > 0,
    }
  );

  return {
    collections,
    ...other,
  };
};

export const useCollection = (
  collectionId: number,
  opts?: {
    enabled?: boolean;
  }
) => {
  const { data: { collection, permissions } = {}, ...rest } = trpc.collection.getById.useQuery(
    {
      id: collectionId,
    },
    {
      enabled: true,
      ...opts,
    }
  );

  return {
    collection,
    permissions,
    ...rest,
  };
};

export const contestCollectionReactionsHidden = (
  collection: Pick<NonNullable<CollectionByIdModel>, 'mode' | 'metadata'>
) => {
  return (
    collection.mode === CollectionMode.Contest &&
    !!collection.metadata?.votingPeriodStart &&
    isFutureDate(collection.metadata?.votingPeriodStart ?? new Date())
  );
};

export const useMutateCollection = () => {
  const queryUtils = trpc.useUtils();
  const removeCollectionItemMutation = trpc.collection.removeFromCollection.useMutation({
    onSuccess: async (res, req) => {
      showSuccessNotification({
        autoClose: 5000, // 10s
        title: 'Item has been removed.',
        message: 'Item has been removed from collection and is no longer visible.',
      });

      if (res.type === CollectionType.Model) {
        // Attempt to update the data:
        await queryUtils.model.getAll.invalidate();
      }

      if (res.type === CollectionType.Image) {
        await queryUtils.image.getInfinite.invalidate();
      }

      await queryUtils.collection.getById.invalidate({ id: req.collectionId as number });
    },
    onError(error) {
      showErrorNotification({
        title: 'Unable to remove item from collection',
        error: new Error(error.message),
      });
    },
  });

  const updateCollectionItemNsfwLevelMutation =
    trpc.collection.updateCollectionItemNSFWLevel.useMutation({
      onSuccess: async (res, req) => {
        showSuccessNotification({
          autoClose: 5000, // 10s
          title: 'NSFW level has been updated.',
          message: 'NSFW level has been updated for the item.',
        });
      },
      onError(error) {
        showErrorNotification({
          title: 'Unable to update NSFW level',
          error: new Error(error.message),
        });
      },
    });

  const joinCollectionAsManagerMutation = trpc.collection.joinCollectionAsManager.useMutation();

  const getYoutubeAuthUrlMutation = trpc.collection.getYoutubeAuthUrl.useMutation();
  const enableYoutubeSupportMutation = trpc.collection.enableYoutubeSupport.useMutation();

  const removeCollectionItemHandler = async (data: RemoveCollectionItemInput) => {
    await removeCollectionItemMutation.mutateAsync(data);
  };

  const updateCollectionItemNsfwLevelHandler = async (
    data: SetCollectionItemNsfwLevelInput,
    opts: Parameters<typeof updateCollectionItemNsfwLevelMutation.mutateAsync>[1]
  ) => {
    await updateCollectionItemNsfwLevelMutation.mutateAsync(data, opts);
  };

  const getYoutubeAuthUrlHandler = async (data: { id: number }) => {
    return getYoutubeAuthUrlMutation.mutateAsync(data);
  };
  const enableYoutubeSupportHandler = async (data: EnableCollectionYoutubeSupportInput) => {
    return enableYoutubeSupportMutation.mutateAsync(data);
  };
  const joinCollectionAsManagerHandler = async (data: { id: number }) => {
    return joinCollectionAsManagerMutation.mutateAsync(data);
  };

  return {
    removeCollectionItem: removeCollectionItemHandler,
    removingCollectionItem: removeCollectionItemMutation.isLoading,
    updateCollectionItemNsfwLevel: updateCollectionItemNsfwLevelHandler,
    updatingCollectionItemNsfwLevel: updateCollectionItemNsfwLevelMutation.isLoading,
    updateCollectionItemNsfwLevelPayload: updateCollectionItemNsfwLevelMutation.variables,
    getYoutubeAuthUrl: getYoutubeAuthUrlHandler,
    getYoutubeAuthUrlLoading: getYoutubeAuthUrlMutation.isLoading,
    enableYoutubeSupport: enableYoutubeSupportHandler,
    enableYoutubeSupportLoading: enableYoutubeSupportMutation.isLoading,
    joinCollectionAsManager: joinCollectionAsManagerHandler,
    joinCollectionAsManagerLoading: joinCollectionAsManagerMutation.isLoading,
  };
};

export const useSetCollectionItemScore = () => {
  const queryUtils = trpc.useUtils();
  const setItemScoreMutation = trpc.collection.setItemScore.useMutation({
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to set item score',
        error: new Error(error.message),
      });
    },
  });

  const setItemScoreHandler = (
    data: SetItemScoreInput,
    opts: Parameters<typeof setItemScoreMutation.mutateAsync>[1]
  ) => {
    return setItemScoreMutation.mutateAsync(data, opts);
  };

  return {
    setItemScore: setItemScoreHandler,
    loading: setItemScoreMutation.isLoading,
  };
};

export const useCollectionEntryCount = (
  collectionId: number,
  opts?: {
    enabled?: boolean;
  }
) => {
  const { data, ...rest } = trpc.collection.getEntryCount.useQuery(
    {
      id: collectionId,
    },
    {
      enabled: true,
      ...opts,
    }
  );

  return {
    data,
    ...rest,
  };
};
