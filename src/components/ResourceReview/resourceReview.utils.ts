import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useMemo } from 'react';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import {
  GetRatingTotalsInput,
  GetResourceReviewsInfiniteInput,
  GetUserResourceReviewInput,
} from '~/server/schema/resourceReview.schema';
import { ResourceReviewPaged, ResourceReviewRatingTotals } from '~/types/router';
import { queryClient, trpc } from '~/utils/trpc';

export const useCreateResourceReview = () => {
  const queryUtils = trpc.useUtils();
  return trpc.resourceReview.create.useMutation({
    onSuccess: async (response, { modelId, recommended, modelVersionId }) => {
      queryUtils.resourceReview.getUserResourceReview.setData({ modelVersionId }, () => response);
      await queryUtils.resourceReview.getRatingTotals.invalidate({ modelId, modelVersionId });

      const previousEngaged = queryUtils.user.getEngagedModels.getData() ?? {
        Recommended: [] as number[],
      };
      const shouldRemove =
        !recommended || (previousEngaged.Recommended?.includes(modelId) ?? false);

      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;

        const { Recommended = [], ...rest } = old;
        if (shouldRemove)
          return { Recommended: Recommended.filter((id) => id !== modelId), ...rest };
        return { Recommended: [...Recommended, modelId], ...rest };
      });
    },
  });
};

export const useUpdateResourceReview = () => {
  const queryUtils = trpc.useUtils();

  return trpc.resourceReview.update.useMutation({
    onSuccess: async ({ id, modelId, modelVersionId }, request) => {
      if (request.recommended != null) {
        await queryUtils.resourceReview.getRatingTotals.invalidate({ modelId, modelVersionId });
      }
      // update single review on model reviews page
      // /models/:id/reviews?modelVersionId
      queryUtils.resourceReview.getUserResourceReview.setData(
        { modelVersionId },
        produce((old) => {
          if (!old) return;
          if (request.details) old.details = request.details as string;
          if (request.rating) old.rating = request.rating;
        })
      );

      // update single review on review details page
      // /reviews/:reviewId
      queryUtils.resourceReview.get.setData(
        { id: request.id },
        produce((old) => {
          if (!old) return;
          if (request.details) old.details = request.details as string;
          if (request.rating) old.rating = request.rating;
        })
      );

      // update paged reviews
      const queryKey = getQueryKey(trpc.resourceReview.getPaged);
      let shouldInvalidate = true;
      queryClient.setQueriesData(
        { queryKey, exact: false },
        produce<ResourceReviewPaged | undefined>((state) => {
          const item = state?.items.find((x) => x.id === id);
          if (item) {
            shouldInvalidate = false;
            if (request.rating) item.rating = request.rating;
            if (request.details) item.details = request.details as string;
          }
        })
      );
      if (shouldInvalidate) {
        // only invalidate if the item wasn't found in the cache
        await queryUtils.resourceReview.getPaged.invalidate();
      }

      await queryUtils.user.getEngagedModels.cancel();

      // Update model engagements
      const previousEngaged = queryUtils.user.getEngagedModels.getData() ?? {
        Recommended: [] as number[],
      };
      const shouldRemove =
        !request.recommended || (previousEngaged.Recommended?.includes(modelId) ?? false);
      // Remove from recommended list
      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;

        const { Recommended = [], ...rest } = old;
        if (shouldRemove)
          return { Recommended: Recommended.filter((id) => id !== modelId), ...rest };
        return { Recommended: [...Recommended, modelId], ...rest };
      });
    },
  });
};

export const useDeleteResourceReview = () => {
  const queryUtils = trpc.useUtils();
  return trpc.resourceReview.delete.useMutation({
    onSuccess: async ({ modelId, modelVersionId, recommended }, { id }) => {
      // reset single review on model reviews page
      // /models/:id/reviews?modelVersionId
      await queryUtils.resourceReview.getUserResourceReview.reset({ modelVersionId });
      // reset single review on review details page
      // /reviews/:reviewId
      await queryUtils.resourceReview.get.reset({ id });

      // Update totals
      queryUtils.resourceReview.getRatingTotals.setData(
        { modelId, modelVersionId },
        produce((old) => {
          if (!old) return;

          if (recommended) old.up -= 1;
          else old.down -= 1;
        })
      );

      // Update engaged models
      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;

        const { Recommended = [], ...rest } = old;
        return { Recommended: Recommended.filter((id) => id !== modelId), ...rest };
      });
    },
  });
};

export const useQueryResourceReview = (
  filters?: Partial<GetResourceReviewsInfiniteInput>,
  options?: { keepPreviousData?: boolean; enabled?: boolean }
) => {
  filters ??= {};
  const { data, ...rest } = trpc.resourceReview.getInfinite.useInfiniteQuery(
    { ...filters },
    {
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : 0),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : 0),
      trpc: { context: { skipBatch: true } },
      ...options,
    }
  );

  const resourceReviews = useMemo(() => data?.pages.flatMap((x) => x.items) ?? [], [data]);

  return { data, resourceReviews, ...rest };
};

export const useQueryUserResourceReview = ({
  modelVersionId,
}: Partial<GetUserResourceReviewInput>) => {
  const currentUser = useCurrentUser();

  if (!modelVersionId) return { currentUserReview: undefined, loading: false };

  const {
    data: currentUserReview,
    isLoading,
    isRefetching,
  } = trpc.resourceReview.getUserResourceReview.useQuery(
    { modelVersionId: modelVersionId },
    { enabled: !!currentUser && !currentUser.muted }
  );

  return { currentUserReview, loading: isLoading || isRefetching };
};

export function roundRating(rating: number) {
  return Math.round(rating * 100) / 100;
}

export function getRatingCount(totals: ResourceReviewRatingTotals | undefined) {
  const count = totals
    ? Object.entries(totals).reduce<number>((acc, [key, value]) => {
        // TODO.review: handle this correctly
        if (key === 'up' || key === 'down') return acc;
        return acc + value;
      }, 0)
    : 0;

  return count;
}
export function getAverageRating(totals: ResourceReviewRatingTotals | undefined, count?: number) {
  if (!count) count = getRatingCount(totals);
  const rating =
    totals && count > 0
      ? Object.entries(totals).reduce<number>((acc, [key, value]) => {
          // TODO.review: handle this correctly
          if (key === 'up' || key === 'down') return acc;
          return acc + Number(key) * value;
        }, 0) / count
      : 0;

  return roundRating(rating);
}

export const useQueryResourceReviewTotals = ({ modelId, modelVersionId }: GetRatingTotalsInput) => {
  const { data, isLoading, isRefetching } = trpc.resourceReview.getRatingTotals.useQuery({
    modelId,
    modelVersionId,
  });

  return { totals: data, loading: isLoading || isRefetching };
};
