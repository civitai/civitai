import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { keepPreviousData } from '@tanstack/react-query';
import { isEqual } from 'lodash-es';
import { useRouter } from 'next/router';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import type { ModelFilterSchema } from '~/providers/FiltersProvider';
import { modelSortPeriodDefaults, useFiltersContext } from '~/providers/FiltersProvider';
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
import { getQueryErrorMessage } from '~/utils/errorHandling';
import { isViewerUsername } from '~/utils/is-viewer';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { publishedDateParam, publishedRangeError } from '~/shared/utils/published-range';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString } from '~/utils/zod-helpers';
import { baseModels } from '~/shared/constants/basemodel.constants';
import { usernameSchema } from '~/shared/zod/username.schema';

const modelQueryParamSchema = z
  .object({
    period: z.enum(MetricTimeframe),
    periodMode: periodModeSchema,
    publishedFrom: publishedDateParam,
    publishedTo: publishedDateParam,
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
    newCreators: booleanString(),
    view: z.enum(['categories', 'feed']),
    section: z.enum(['published', 'private', 'draft', 'training']),
    collectionId: z.coerce.number(),
    excludedTagIds: z.array(z.coerce.number()),
    excludedImageTagIds: z.array(z.coerce.number()),
    baseModels: z.preprocess(
      (val) => (Array.isArray(val) ? val : [val]),
      z.array(z.enum(baseModels))
    ),
    collectionTagId: z.coerce.number().optional(),
    earlyAccess: booleanString().optional(),
    paidAccess: booleanString().optional(),
    hidePaid: booleanString().optional(),
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

// The /models toolbar filters that live in the URL, so a filtered browse can be bookmarked or
// shared. `hidden`, `followed` and the moderator flags stay in the store only.
const MODEL_BROWSE_FILTER_KEYS = [
  'sort',
  'period',
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
  'fromPlatform',
  'isFeatured',
] as const satisfies readonly (keyof ModelFilterSchema & keyof ModelQueryParams)[];
type ModelBrowseFilters = Pick<ModelFilterSchema, (typeof MODEL_BROWSE_FILTER_KEYS)[number]>;
const isBrowseKey = (key: string) => (MODEL_BROWSE_FILTER_KEYS as readonly string[]).includes(key);
const unsetBrowseFilters = Object.fromEntries(
  MODEL_BROWSE_FILTER_KEYS.map((key) => [key, undefined])
) as Record<keyof ModelBrowseFilters, undefined>;

// Only what departs from the default, so the URL carries what the visitor chose and nothing else.
function compactBrowseFilters(filters: Partial<ModelBrowseFilters>) {
  const compact: Partial<ModelBrowseFilters> = {};
  for (const key of MODEL_BROWSE_FILTER_KEYS) {
    const value = filters[key];
    if (value === undefined || value === false || (Array.isArray(value) && !value.length)) continue;
    if (key === 'sort' || key === 'period') {
      if (value === modelSortPeriodDefaults[key]) continue;
    }
    (compact as Record<string, unknown>)[key] = value;
  }
  // The server refuses a half or over-wide range, so a bookmark carrying one drops it.
  if (publishedRangeError({ from: compact.publishedFrom, to: compact.publishedTo })) {
    delete compact.publishedFrom;
    delete compact.publishedTo;
  }
  return compact;
}

/**
 * The /models filters. A URL that carries filters is the whole truth, so a bookmark never picks up
 * the visitor's own stored filters; with none in the URL the stored filters apply, as they always
 * have. Writes go to both, so the next bare visit and the address bar agree.
 */
export const useModelBrowseFilters = () => {
  const params = useModelQueryParams();
  const stored = useFiltersContext((state) => state.models);
  const setStored = useFiltersContext((state) => state.setModelFilters);

  const urlFilters = useMemo(() => compactBrowseFilters(params), [params]);
  const hasUrlFilters = Object.keys(urlFilters).length > 0;
  const droppedPublishedRange =
    !!(params.publishedFrom || params.publishedTo) && !urlFilters.publishedFrom;

  const filters = useMemo<ModelFilterSchema>(
    () =>
      hasUrlFilters
        ? { ...stored, ...unsetBrowseFilters, ...modelSortPeriodDefaults, ...urlFilters }
        : stored,
    [hasUrlFilters, stored, urlFilters]
  );

  const setFilters = (next: Partial<ModelFilterSchema>) => {
    // A key absent from `next` keeps its value: the dropdown's Clear leaves the sort alone.
    const browse: Partial<ModelBrowseFilters> = { ...filters };
    const storeOnly: Partial<ModelFilterSchema> = {};
    for (const [key, value] of Object.entries(next)) {
      if (isBrowseKey(key)) (browse as Record<string, unknown>)[key] = value;
      else (storeOnly as Record<string, unknown>)[key] = value;
    }
    const compact = compactBrowseFilters(browse);
    setStored({ ...storeOnly, ...unsetBrowseFilters, ...modelSortPeriodDefaults, ...compact });
    params.set({ ...unsetBrowseFilters, ...compact });
  };

  return {
    filters,
    setFilters,
    hasUrlFilters,
    /** Spread over the URL params: the URL's own filters, cleaned, and not the stored ones. */
    feedOverrides: hasUrlFilters
      ? { ...unsetBrowseFilters, ...modelSortPeriodDefaults, ...urlFilters }
      : droppedPublishedRange
      ? { publishedFrom: undefined, publishedTo: undefined }
      : {},
  };
};

/** Run once, by the /models page. Keeps the store and the address bar in step. */
export const useModelBrowseUrlSync = () => {
  const { isReady } = useRouter();
  const params = useModelQueryParams();
  const stored = useFiltersContext((state) => state.models);
  const setStored = useFiltersContext((state) => state.setModelFilters);

  const urlFilters = useMemo(() => compactBrowseFilters(params), [params]);
  const hasUrlFilters = Object.keys(urlFilters).length > 0;

  // Read through a ref: a store write lands before the router's, and re-running this on that
  // write would put the old URL back into the store.
  const storedRef = useRef(stored);
  storedRef.current = stored;

  // Without this, Clear on a bookmark would bring the filters back on the next bare visit.
  useEffect(() => {
    if (!isReady || !hasUrlFilters) return;
    if (isEqual(compactBrowseFilters(storedRef.current), urlFilters)) return;
    setStored({ ...unsetBrowseFilters, ...modelSortPeriodDefaults, ...urlFilters });
  }, [isReady, hasUrlFilters, urlFilters, setStored]);

  // So the address bar can be bookmarked as it stands.
  useEffect(() => {
    if (!isReady || hasUrlFilters) return;
    const compact = compactBrowseFilters(stored);
    if (Object.keys(compact).length) params.set(compact);
  }, [isReady, hasUrlFilters, stored, params]);
};

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
    ...(isViewerUsername(currentUser, _filters.username)
      ? []
      : browsingSettingsAddons.settings.excludedTagIds ?? []),
  ];
  const queryUtils = trpc.useUtils();
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, error, ...rest } = trpc.model.getAll.useInfiniteQuery(
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
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : undefined),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : undefined),
      trpc: { context: { skipBatch: true } },
      placeholderData: keepPreviousData,
      ...withPlaceholderData(options),
    }
  );
  // v5: query onError removed — preserve prior data and notify on fetch failure.
  useEffect(() => {
    if (!error) return;
    queryUtils.model.getAll.setInfiniteData(
      { ..._filters, browsingLevel },
      // cast: v5 InfiniteData pageParams typing (bigint vs string|number) is stricter here.
      (oldData) => oldData ?? (data as typeof oldData)
    );
    showErrorNotification({
      title: 'Failed to fetch data',
      error: new Error(getQueryErrorMessage(error)),
    });
  }, [error]); // eslint-disable-line react-hooks/exhaustive-deps

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items, loadingPreferences } = useApplyHiddenPreferences({
    type: 'models',
    data: flatData,
    showHidden: !!_filters.hidden,
    showImageless:
      (_filters.status ?? []).includes(ModelStatus.Draft) ||
      _filters.pending ||
      _filters.availability === Availability.Private,
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

/**
 * The showcase fetches this once and then links out to the collection, so it is the whole
 * list rather than a page of one — `model.getAll` is rate limited at the edge, and the
 * widget walking a collection a page at a time is what tripped that limit.
 */
const SHOWCASE_PAGE_SIZE = 50;

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
      limit: SHOWCASE_PAGE_SIZE,
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
    settingShowcase: setShowcaseMutation.isPending,
  };
};
