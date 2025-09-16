import { isEqual } from 'lodash-es';
import { useRouter } from 'next/router';
import { useMemo, useState } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { constants } from '~/server/common/constants';
import { ModelSort } from '~/server/common/enums';
import { periodModeSchema } from '~/server/schema/base.schema';
import type {
  GetAllModelsInput,
  ToggleCheckpointCoverageInput,
} from '~/server/schema/model.schema';
import {
  Availability,
  CheckpointType,
  MetricTimeframe,
  ModelStatus,
  ModelType,
} from '~/shared/utils/prisma/enums';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString } from '~/utils/zod-helpers';
import { baseModels } from '~/shared/constants/base-model.constants';
import { usernameSchema } from '~/shared/zod/username.schema';

const modelQueryParamSchema = z
  .object({
    period: z.enum(MetricTimeframe),
    periodMode: periodModeSchema,
    sort: z.enum(ModelSort),
    query: z.string(),
    user: z.string(),
    username: usernameSchema.transform(postgresSlugify),
    tagname: z.string(),
    tag: z.string(),
    favorites: booleanString(),
    hidden: booleanString(),
    archived: booleanString(),
    followed: booleanString(),
    view: z.enum(['categories', 'feed']),
    section: z.enum(['published', 'private', 'draft', 'training']),
    collectionId: z.coerce.number(),
    excludedTagIds: z.array(z.coerce.number()),
    excludedImageTagIds: z.array(z.coerce.number()),
    baseModels: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(baseModels))
    ),
    clubId: z.coerce.number().optional(),
    collectionTagId: z.coerce.number().optional(),
    earlyAccess: booleanString().optional(),
    types: z
      .preprocess((val) => (Array.isArray(val) ? val : [val]), z.enum(ModelType).array())
      .optional(),
    checkpointType: z.enum(CheckpointType).optional(),
    supportsGeneration: booleanString().optional(),
    status: z
      .preprocess((val) => (Array.isArray(val) ? val : [val]), z.enum(ModelStatus).array())
      .optional(),
    fileFormats: z
      .preprocess(
        (val) => (Array.isArray(val) ? val : [val]),
        z.enum(constants.modelFileFormats).array()
      )
      .optional(),
    fromPlatform: booleanString().optional(),
    availability: z.enum(Availability).optional(),
    disablePoi: z.boolean().optional(),
    disableMinor: z.boolean().optional(),
    isFeatured: booleanString().optional(),
  })
  .partial();
export type ModelQueryParams = z.output<typeof modelQueryParamSchema>;
export const useModelQueryParams = () => {
  const { query, pathname, replace } = useRouter();

  return useMemo(() => {
    const result = modelQueryParamSchema.safeParse(query);
    const data: ModelQueryParams = result.success ? result.data : {};

    return {
      ...data,
      set: (filters: Partial<ModelQueryParams>, pathnameOverride?: string) => {
        replace(
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
  }, [query, pathname, replace]);
};

export const useModelQueryParams2 = () => useZodRouteParams(modelQueryParamSchema);

export const useModelFilters = () => {
  const storeFilters = useFiltersContext((state) => state.models);
  return removeEmpty(storeFilters);
};

export const useDumbModelFilters = (defaultFilters?: Partial<Omit<GetAllModelsInput, 'page'>>) => {
  const [filters, setFilters] = useState<Partial<Omit<GetAllModelsInput, 'page'>>>(
    defaultFilters ?? {}
  );
  const filtersUpdated = !isEqual(filters, defaultFilters);

  return {
    filters,
    setFilters,
    filtersUpdated,
  };
};

export type UseQueryModelReturn = ReturnType<typeof useQueryModels>['models'];
export const useQueryModels = (
  filters?: Partial<Omit<GetAllModelsInput, 'page'>>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  const currentUser = useCurrentUser();
  const _filters = filters ?? {};
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const excludedTagIds = [
    ...(_filters.excludedTagIds ?? []),
    ...(_filters.username &&
    _filters.username?.toLowerCase() === currentUser?.username?.toLowerCase()
      ? []
      : browsingSettingsAddons.settings.excludedTagIds ?? []),
  ];
  const queryUtils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.model.getAll.useInfiniteQuery(
    {
      ..._filters,
      browsingLevel,
      excludedTagIds,
      disablePoi: browsingSettingsAddons.settings.disablePoi
        ? // Ensures we pass true explicitly
          true
        : undefined,
      disableMinor: browsingSettingsAddons.settings.disableMinor
        ? // Ensures we pass true explicitly
          true
        : undefined,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      keepPreviousData: true,
      onError: (error) => {
        queryUtils.model.getAll.setInfiniteData(
          { ..._filters, browsingLevel },
          (oldData) => oldData ?? data
        );
        showErrorNotification({
          title: 'Failed to fetch data',
          error: new Error(`Something went wrong: ${error.message}`),
        });
      },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'models',
    data: flatData,
    showHidden: !!_filters.hidden,
    showImageless: (_filters.status ?? []).includes(ModelStatus.Draft) || _filters.pending,
    isRefetching: rest.isRefetching,
    hiddenTags: excludedTagIds,
  });

  return { data, models: items, isLoading: isLoading || loadingPreferences, ...rest };
};

export const useToggleCheckpointCoverageMutation = () => {
  const queryUtils = trpc.useUtils();

  const toggleMutation = trpc.model.toggleCheckpointCoverage.useMutation({
    onSuccess: (_, { id, versionId }) => {
      queryUtils.model.getById.setData({ id }, (old) => {
        if (!old) return old;

        return {
          ...old,
          modelVersions: old.modelVersions.map((v) =>
            v.id === versionId ? { ...v, canGenerate: !v.canGenerate } : v
          ),
        };
      });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to toggle checkpoint coverage',
        error: new Error(error.message),
      });
    },
  });

  const handleToggle = (data: ToggleCheckpointCoverageInput) => {
    return toggleMutation.mutateAsync(data);
  };

  return { ...toggleMutation, toggle: handleToggle };
};

export const useModelShowcaseCollection = ({ modelId }: { modelId: number }) => {
  const queryUtils = trpc.useUtils();

  const { data: showcase, isLoading: loadingCollection } =
    trpc.model.getCollectionShowcase.useQuery({ id: modelId });

  const {
    data,
    models,
    isLoading: loadingModels,
    ...rest
  } = useQueryModels(
    {
      collectionId: showcase?.id,
      sort: ModelSort.Newest,
      period: MetricTimeframe.AllTime,
      periodMode: 'published',
      limit: 10,
    },
    { enabled: !loadingCollection && !!showcase?.id, keepPreviousData: true }
  );

  const setShowcaseMutation = trpc.model.setCollectionShowcase.useMutation({
    onSuccess: async () => {
      await queryUtils.model.getCollectionShowcase.invalidate({ id: modelId });
    },
    onError: (error) => {
      showErrorNotification({
        title: 'Failed to set showcase collection',
        error: new Error(error.message),
      });
    },
  });
  const handleSetShowcaseCollection = (collectionId: number) => {
    return setShowcaseMutation.mutateAsync({ id: modelId, collectionId });
  };

  return {
    ...rest,
    collection: showcase,
    items: models,
    isLoading: loadingCollection || loadingModels,
    setShowcaseCollection: handleSetShowcaseCollection,
    settingShowcase: setShowcaseMutation.isLoading,
  };
};
