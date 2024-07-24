import { MetricTimeframe } from '@prisma/client';
import { useMemo } from 'react';
import { z } from 'zod';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { useZodRouteParams } from '~/hooks/useZodRouteParams';
import { useFiltersContext } from '~/providers/FiltersProvider';
import { PostSort } from '~/server/common/enums';
import { PostsQueryInput, UpdatePostCollectionTagIdInput } from '~/server/schema/post.schema';
import { showErrorNotification } from '~/utils/notifications';
import { removeEmpty } from '~/utils/object-helpers';
import { postgresSlugify } from '~/utils/string-helpers';
import { trpc } from '~/utils/trpc';
import { numericString, numericStringArray } from '~/utils/zod-helpers';

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
    period: z.nativeEnum(MetricTimeframe),
    sort: z.nativeEnum(PostSort),
    collectionId: numericString(),
    section: z.enum(['published', 'draft']),
    followed: z.coerce.boolean(),
  })
  .partial();

export const useQueryPosts = (
  filters?: Partial<PostsQueryInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const browsingLevel = useBrowsingLevelDebounced();
  const { data, isLoading, ...rest } = trpc.post.getInfinite.useInfiniteQuery(
    { ...filters, include: ['cosmetics'], browsingLevel },
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
  const { data: collectionItems = [], ...rest } = trpc.post.getContestCollectionDetails.useQuery(
    { ...filters },
    {
      ...options,
    }
  );

  return {
    collectionItems,
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
