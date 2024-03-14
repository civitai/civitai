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
      queryUtils.resourceReview.getUserResourceReview.setData({ modelId }, (old) => {
        return [
          ...(old ?? []).filter((review) => review.modelVersionId !== modelVersionId),
          response,
        ];
      });
      queryUtils.resourceReview.getRatingTotals.setData({ modelId, modelVersionId }, (old) => {
        if (!old) return old;
        if (recommended) return { ...old, up: old.up + 1 };
        return { ...old, down: old.down + 1 };
      });

      const previousEngaged = queryUtils.user.getEngagedModels.getData() ?? {
        Recommended: [] as number[],
      };
      const shouldRemove =
        !recommended || (previousEngaged.Recommended?.includes(modelId) ?? false);

      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;

        const { Recommended = [], Notify = [], ...rest } = old;
        if (shouldRemove) {
          return {
            Recommended: Recommended.filter((id) => id !== modelId),
            Notify: Notify.filter((id) => id !== modelId),
            ...rest,
          };
        }

        return { Recommended: [...Recommended, modelId], Notify: [...Notify, modelId], ...rest };
      });

      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;

        if (recommended) {
          old.rank.thumbsUpCountAllTime += 1;
          old.rank.collectedCountAllTime += 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId) {
                version.rank.thumbsUpCountAllTime += 1;
              }
              return version;
            });
          }
        } else {
          old.rank.thumbsDownCountAllTime += 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId) {
                version.rank.thumbsDownCountAllTime += 1;
              }
              return version;
            });
          }
        }

        return old;
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
        { modelId },
        produce((old) => {
          if (!old) return;
          old.forEach((review) => {
            if (review.modelVersionId === modelVersionId) {
              if (request.details) review.details = request.details as string;
              if (request.recommended != null) review.recommended = request.recommended;
            }
          });
        })
      );

      // update single review on review details page
      // /reviews/:reviewId
      queryUtils.resourceReview.get.setData(
        { id: request.id },
        produce((old) => {
          if (!old) return;

          if (request.recommended != null) old.recommended = request.recommended;
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
        Notify: [] as number[],
      };
      const alreadyNotified = previousEngaged.Notify?.indexOf(modelId) ?? -1;
      const alreadyReviewed = previousEngaged.Recommended?.indexOf(modelId) ?? -1;
      const shouldRemove = !request.recommended || alreadyReviewed > -1;
      // Remove from recommended list
      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;

        const { Recommended = [], ...rest } = old;
        if (shouldRemove)
          return { Recommended: Recommended.filter((id) => id !== modelId), ...rest };
        return { Recommended: [...Recommended, modelId], ...rest };
      });

      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;

        if (request.recommended === true) {
          old.rank.thumbsUpCountAllTime += 1;
          if (alreadyNotified === -1) old.rank.collectedCountAllTime += 1;
          if (old.rank.thumbsDownCountAllTime > 0) old.rank.thumbsDownCountAllTime -= 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId) {
                version.rank.thumbsUpCountAllTime += 1;
                if (version.rank.thumbsDownCountAllTime > 0)
                  version.rank.thumbsDownCountAllTime -= 1;
              }
              return version;
            });
          }
        } else if (request.recommended === false) {
          old.rank.thumbsDownCountAllTime += 1;
          if (old.rank.thumbsUpCountAllTime > 0) old.rank.thumbsUpCountAllTime -= 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId) {
                version.rank.thumbsDownCountAllTime += 1;
                if (version.rank.thumbsUpCountAllTime > 0) version.rank.thumbsUpCountAllTime -= 1;
              }
              return version;
            });
          }
        }

        return old;
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
      await queryUtils.resourceReview.getUserResourceReview.reset({ modelId });
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

        const { Recommended = [], Notify = [], ...rest } = old;
        return {
          Recommended: Recommended.filter((id) => id !== modelId),
          Notify: Notify.filter((id) => id !== modelId),
          ...rest,
        };
      });

      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;

        if (recommended && old.rank.thumbsUpCountAllTime > 0) {
          old.rank.thumbsUpCountAllTime -= 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId && version.rank.thumbsUpCountAllTime > 0) {
                version.rank.thumbsUpCountAllTime -= 1;
              }
              return version;
            });
          }
        } else {
          if (old.rank.thumbsDownCountAllTime > 0) old.rank.thumbsDownCountAllTime -= 1;

          if (modelVersionId) {
            old.modelVersions = old.modelVersions.map((version) => {
              if (version.id === modelVersionId && version.rank.thumbsDownCountAllTime > 0) {
                version.rank.thumbsDownCountAllTime -= 1;
              }
              return version;
            });
          }
        }

        return old;
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
  modelId,
  modelVersionId,
}: Partial<GetUserResourceReviewInput>) => {
  const currentUser = useCurrentUser();

  if (!modelId) return { currentUserReview: undefined, loading: false };

  const { data, isLoading, isRefetching } = trpc.resourceReview.getUserResourceReview.useQuery(
    { modelId },
    { enabled: !!currentUser && !currentUser.muted }
  );

  let currentUserReviews = data;
  if (modelVersionId) currentUserReviews = data?.filter((x) => x.modelVersionId === modelVersionId);

  return { currentUserReview: currentUserReviews?.[0], loading: isLoading || isRefetching };
};

export function useToggleFavoriteMutation() {
  const queryUtils = trpc.useUtils();

  const mutation = trpc.user.toggleFavorite.useMutation({
    onMutate: async ({ modelId, modelVersionId, setTo }) => {
      const engagedModels = queryUtils.user.getEngagedModels.getData();
      const modelDetails = queryUtils.model.getById.getData({ id: modelId });

      // Update model engagements
      const alreadyNotified = engagedModels?.Notify?.indexOf(modelId) ?? -1;
      const alreadyReviewed = engagedModels?.Recommended?.indexOf(modelId) ?? -1;
      queryUtils.user.getEngagedModels.setData(undefined, (old) => {
        if (!old) return;
        if (setTo) {
          if (alreadyNotified === -1) old.Notify = [...(old.Notify ?? []), modelId];
          if (alreadyReviewed === -1) old.Recommended = [...(old.Recommended ?? []), modelId];
        } else {
          // We don't want to remove from notify on favorite toggle
          // if (alreadyNotified !== -1) old.Notify = old.Notify.filter((id) => id !== modelId);
          if (alreadyReviewed !== -1)
            old.Recommended = old.Recommended.filter((id) => id !== modelId);
        }
        return old;
      });

      // Update model details
      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;
        if (setTo && alreadyReviewed === -1) {
          old.rank.thumbsUpCountAllTime += 1;
          if (alreadyNotified === -1) old.rank.collectedCountAllTime += 1;
        } else if (!setTo && alreadyReviewed !== -1) {
          old.rank.thumbsUpCountAllTime -= 1;
          // We don't want to remove from collected on favorite toggle
          // old.rank.collectedCountAllTime -= 1;
        }

        if (old.rank.thumbsUpCountAllTime < 0) old.rank.thumbsUpCountAllTime = 0;
        if (old.rank.collectedCountAllTime < 0) old.rank.collectedCountAllTime = 0;

        // Update model version details
        old.modelVersions = old.modelVersions.map((version) => {
          if (version.id === modelVersionId) {
            if (setTo) version.rank.thumbsUpCountAllTime += 1;
            else version.rank.thumbsUpCountAllTime -= 1;

            if (version.rank.thumbsUpCountAllTime < 0) version.rank.thumbsUpCountAllTime = 0;
          }
          return version;
        });

        return old;
      });

      // Update user reviews
      const firstVersionId = modelDetails?.modelVersions?.[0]?.id;
      const userReviews = queryUtils.resourceReview.getUserResourceReview.getData({ modelId });
      queryUtils.resourceReview.getUserResourceReview.setData({ modelId }, (old) => {
        // Handle removal of review
        if (!setTo) {
          if (modelVersionId)
            return old?.filter((review) => review.modelVersionId !== modelVersionId);
          return [];
        }
        if (setTo) {
          if (!old) old = [];
          const targetVersion = modelVersionId ?? firstVersionId;
          const existingReview = old.find((review) => review.modelVersionId === targetVersion);
          if (!targetVersion) return old;

          // Handle adding new review
          if (!existingReview)
            return [
              ...old,
              {
                id: 0,
                modelId,
                modelVersionId: targetVersion,
                recommended: true,
                createdAt: new Date(),
                exclude: false,
              } as (typeof old)[number],
            ];
          // Handle updating existing review
          return old.map((review) => {
            if (review.modelVersionId === targetVersion) review.recommended = setTo;
            return review;
          });
        }
      });

      return { prevData: { engagedModels, modelDetails, userReviews } };
    },
    onError: (error, { modelId }, context) => {
      queryUtils.user.getEngagedModels.setData(undefined, context?.prevData?.engagedModels);
      queryUtils.model.getById.setData({ id: modelId }, context?.prevData?.modelDetails);
    },
    onSettled: async (result, error, { modelId }) => {
      await queryUtils.resourceReview.getUserResourceReview.invalidate({ modelId });
    },
  });

  return mutation;
}

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

export const useQueryResourceReviewTotals = (
  { modelId, modelVersionId }: GetRatingTotalsInput,
  options?: { enabled?: boolean }
) => {
  const { data, isLoading, isRefetching } = trpc.resourceReview.getRatingTotals.useQuery(
    {
      modelId,
      modelVersionId,
    },
    { ...options }
  );

  return { totals: data, loading: isLoading || isRefetching };
};
