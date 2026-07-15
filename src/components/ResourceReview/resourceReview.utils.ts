import { withPlaceholderData } from '~/hooks/trpcHelpers';
import { getQueryKey } from '@trpc/react-query';
import produce from 'immer';
import { useMemo } from 'react';

import { useCurrentUser } from '~/hooks/useCurrentUser';
import type {
  GetRatingTotalsInput,
  GetResourceReviewsInfiniteInput,
  GetUserResourceReviewInput,
} from '~/server/schema/resourceReview.schema';
import type { ResourceReviewPaged, ResourceReviewRatingTotals } from '~/types/router';
import { queryClient, trpc } from '~/utils/trpc';
import { restoreMembership, snapshotMembership } from '~/store/engaged-models.store';
import {
  applyFavoriteToggled,
  applyReviewCreated,
  applyReviewDeleted,
  applyReviewUpdated,
} from '~/store/engaged-models.optimistic';

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

      // Normalized store: mirror the Recommended+Notify toggle for the per-visible-set
      // surfaces. The legacy `user.getEngagedModels` cache dual-write was removed with the
      // endpoint (PR4). That cache was never populated after the feeds migrated off it
      // (PR3) — nothing queried it — so the `alreadyRecommended` direction it fed here
      // always resolved to `false`; preserved as the literal below (behavior-identical).
      applyReviewCreated(modelId, recommended, false);

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

      // Normalized store: mirror the Recommended toggle for per-visible-set surfaces.
      // The legacy `user.getEngagedModels` cache dual-write was removed with the endpoint
      // (PR4); it was never populated after the feeds migrated off it (PR3), so the
      // `alreadyRecommended` direction always resolved to `false` here — preserved below.
      applyReviewUpdated(modelId, request.recommended, false);

      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;

        if (request.recommended === true) {
          old.rank.thumbsUpCountAllTime += 1;
          // Legacy `getEngagedModels` cache is gone (PR4); its `alreadyNotified` was always
          // -1 (cache never populated), so this collected bump was always applied.
          old.rank.collectedCountAllTime += 1;
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

      // Normalized store: mirror the Recommended+Notify removal for per-visible-set surfaces.
      // (The legacy `user.getEngagedModels` cache dual-write was removed with the endpoint — PR4.)
      applyReviewDeleted(modelId);

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
      getNextPageParam: (lastPage) => (!!lastPage ? lastPage.nextCursor : undefined),
      getPreviousPageParam: (firstPage) => (!!firstPage ? firstPage.nextCursor : undefined),
      trpc: { context: { skipBatch: true } },
      ...withPlaceholderData(options),
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
      const bookmarkedModels = queryUtils.user.getBookmarkedModels.getData();
      const modelDetails = queryUtils.model.getById.getData({ id: modelId });
      // Normalized store (PR2): snapshot for rollback, then apply the same toggle.
      const engagedMembership = snapshotMembership(modelId);

      // update liked models
      // nb: should technically update the "liked models" collection too
      queryUtils.user.getBookmarkedModels.setData(undefined, (old) => {
        if (!old) return old;
        if (setTo) {
          return [modelId, ...old];
        } else {
          return old.filter((o) => o !== modelId);
        }
      });

      // Normalized store: mirror the favorite toggle for per-visible-set surfaces.
      // The legacy `user.getEngagedModels` cache dual-write was removed with the endpoint
      // (PR4); that cache was never populated after the feeds migrated off it (PR3), so its
      // `alreadyNotified` / `alreadyReviewed` were always -1 — the rank adjustments below
      // are preserved exactly as they resolved with those constants (the `!setTo` up-count
      // decrement branch, gated on `alreadyReviewed !== -1`, was already unreachable).
      applyFavoriteToggled(modelId, setTo);

      // Update model details
      queryUtils.model.getById.setData({ id: modelId }, (old) => {
        if (!old) return;
        if (setTo) {
          old.rank.thumbsUpCountAllTime += 1;
          old.rank.collectedCountAllTime += 1;
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

      return { prevData: { modelDetails, userReviews, bookmarkedModels }, engagedMembership };
    },
    onError: (error, { modelId }, context) => {
      queryUtils.user.getBookmarkedModels.setData(undefined, context?.prevData?.bookmarkedModels);
      queryUtils.model.getById.setData({ id: modelId }, context?.prevData?.modelDetails);
      // Normalized store (PR2): restore the snapshotted membership.
      if (context?.engagedMembership) restoreMembership(modelId, context.engagedMembership);
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
