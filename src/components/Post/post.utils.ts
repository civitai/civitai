import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { useMemo } from 'react';
import * as z from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PostSort } from '~/server/common/enums';
import type { PostsQueryInput, UpdatePostCollectionTagIdInput } from '~/server/schema/post.schema';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { booleanString, numericString, numericStringArray } from '~/utils/zod-helpers';
import { useBrowsingSettingsAddons } from '~/providers/BrowsingSettingsAddonsProvider';
import { isDefined } from '~/utils/type-guards';
import { useCurrentUser } from '~/hooks/useCurrentUser';

export const usePostQueryParams = () => useZodRouteParams(postQueryParamSchema);

export const usePostFilters = () => {
  const storeFilters = useFiltersContext((state) => state.posts);
  const { query } = usePostQueryParams();
  const browsingLevel = useBrowsingLevelDebounced();
  return removeEmpty({ browsingLevel, ...storeFilters, ...query });
};

const postQueryParamSchema = z
  .object({
    tags: numericStringArray(),
    modelId: numericString(),
    modelVersionId: numericString(),
    username: z.string().transform(postgresSlugify).nullish(),
    view: z.enum(['categories', 'feed']),
    period: z.enum(MetricTimeframe),
    sort: z.enum(PostSort),
    collectionId: numericString(),
    section: z.enum(['published', 'draft']),
    followed: booleanString().optional(),
  })
  .partial();

export const useQueryPosts = (
  filters?: Partial<PostsQueryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const currentUser = useCurrentUser();
  const browsingLevel = useBrowsingLevelDebounced();
  const browsingSettingsAddons = useBrowsingSettingsAddons();
  const excludedTagIds = [
    ...(filters.excludedTagIds ?? []),
    ...(filters.username && filters.username.toLowerCase() === currentUser?.username?.toLowerCase()
      ? []
      : browsingSettingsAddons.settings.excludedTagIds ?? []),
  ].filter(isDefined);
  const { data, isLoading, ...rest } = trpc.post.getInfinite.useInfiniteQuery(
    {
      ...filters,
      include: ['cosmetics'],
      browsingLevel,
      excludedTagIds,
      disablePoi: browsingSettingsAddons.settings.disablePoi,
      disableMinor: browsingSettingsAddons.settings.disableMinor,
    },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const flatData = useMemo(() => data?.pages.flatMap((x) => (!!x ? x.items : [])), [data]);
  const { items: posts, loadingPreferences } = useApplyHiddenPreferences({
    type: 'posts',
    data: flatData,
    isRefetching: rest.isRefetching,
  });

  return { data, posts, isLoading: isLoading || loadingPreferences, ...rest };
};

export const usePostContestCollectionDetails = (
  filters: { id: number },
  options?: { enabled: boolean }
) => {
  const { data, ...rest } = trpc.post.getContestCollectionDetails.useQuery(
    { ...filters },
    {
      ...options,
    }
  );

  return {
    collectionItems: data?.items ?? [],
    collection: data?.collection ?? null,
    permissions: data?.permissions ?? { manage: false },
    ...rest,
  };
};

export const useMutatePost = () => {
  const updateCollectionTagId = trpc.post.updateCollectionTagId.useMutation({
    onError(error) {
      onError(error, 'Failed to create a withdrawal request');
    },
  });

  const onError = (error: any, message = 'There was an error while performing your request') => {
    try {
      // If failed in the FE - TRPC error is a JSON string that contains an array of errors.
      const parsedError = JSON.parse(error.message);
      showErrorNotification({
        title: message,
        error: parsedError,
      });
    } catch (e) {
      // Report old error as is:
      showErrorNotification({
        title: message,
        error: new Error(error.message),
      });
    }
  };

  const handleUpdateCollectionTagId = async (input: UpdatePostCollectionTagIdInput) => {
    await updateCollectionTagId.mutateAsync(input);
  };

  return {
    updateCollectionTagId: handleUpdateCollectionTagId,
    updatingCollectionTagId: updateCollectionTagId.isLoading,
  };
};
