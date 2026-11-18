import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { usePostEditStore } from '~/components/Post/EditV2/PostEditProvider';
import type { ReviewPatch } from '~/components/Post/EditV2/PostResourceReviews/postResourceReviews.utils';
import {
  countReviews,
  dedupeByModelVersion,
  patchReview,
} from '~/components/Post/EditV2/PostResourceReviews/postResourceReviews.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { showErrorNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

// In-flight writes live outside the hook so every consumer on the page shares one lock.
const pending = new Set<string>();
const listeners = new Set<() => void>();
let pendingVersion = 0;
const setPending = (key: string, on: boolean) => {
  if (on) pending.add(key);
  else pending.delete(key);
  pendingVersion++;
  listeners.forEach((l) => l());
};
export const resetPendingForTests = () => {
  pending.clear();
  pendingVersion++;
  syncFetches.clear();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
// The first load of each post's reviews. A rating waits for its own post's load instead of cancelling it.
const syncFetches = new Map<number, Promise<unknown>>();
const pendingKey = (postId: number, modelVersionId: number) => `${postId}:${modelVersionId}`;

export type RateResult = 'saved' | 'ignored' | 'failed';
export type SaveDetailsResult = RateResult | 'needs-rating';

type SaveBody = { rating: number; recommended: boolean; details?: string };

const useCanReview = (ownerId: number) => {
  const currentUser = useCurrentUser();
  const isMuted = currentUser?.muted ?? false;
  // A moderator editing someone else's post must not review under their own account.
  const isOwner = !!currentUser && currentUser.id === ownerId;
  return { isMuted, isOwner, canReview: !isMuted && isOwner };
};

/**
 * Loads the current user's reviews into the `post.getResources` cache on mount and whenever the
 * post's image resources change. Mount it once per post; consumers only read the cache.
 */
export function usePostResourceReviewsSync({
  postId,
  ownerId,
}: {
  postId: number;
  ownerId: number;
}) {
  const { canReview } = useCanReview(ownerId);
  const storeImages = usePostEditStore((state) => state.images);
  const resourceKey = useMemo(
    () =>
      [
        ...new Set(
          storeImages
            .map((x) => (x.type === 'added' ? x.data : undefined))
            .filter(isDefined)
            .flatMap((x) => x.resourceHelper)
            .map((x) => x.modelVersionId)
        ),
      ]
        .sort((a, b) => a - b)
        .join(','),
    [storeImages]
  );

  const { refetch } = trpc.post.getResources.useQuery({ id: postId }, { enabled: false });

  // Keyed on the version ids, not row counts: the server drops VAEs, so the counts never match.
  const fetchedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!canReview || fetchedKey.current === resourceKey) return;
    fetchedKey.current = resourceKey;
    const fetch = refetch().finally(() => {
      if (syncFetches.get(postId) === fetch) syncFetches.delete(postId);
    });
    syncFetches.set(postId, fetch);
  }, [resourceKey, canReview, refetch, postId]);
}

export function PostResourceReviewsSync(props: { postId: number; ownerId: number }) {
  usePostResourceReviewsSync(props);
  return null;
}

/**
 * The current user's reviews of a post's resources, keyed by model version and shared by every
 * consumer through the `post.getResources` cache. Never fetches; see `usePostResourceReviewsSync`.
 */
export function usePostResourceReviews({ postId, ownerId }: { postId: number; ownerId: number }) {
  const queryUtils = trpc.useUtils();
  const { canReview, isMuted, isOwner } = useCanReview(ownerId);

  const { data } = trpc.post.getResources.useQuery({ id: postId }, { enabled: false });
  // The post's owner is the reviewer, and nobody reviews their own model.
  const reviews = useMemo(
    () => dedupeByModelVersion(data ?? []).filter((r) => r.modelUserId !== ownerId),
    [data, ownerId]
  );
  const byModelVersionId = useMemo(
    () => new Map(reviews.map((r) => [r.modelVersionId as number, r])),
    [reviews]
  );
  const counts = useMemo(() => countReviews(reviews), [reviews]);

  useSyncExternalStore(
    subscribe,
    () => pendingVersion,
    () => 0
  );
  const isPending = (modelVersionId: number) => pending.has(pendingKey(postId, modelVersionId));

  const { mutateAsync: upsert } = trpc.resourceReview.upsert.useMutation();

  const save = useCallback(
    async (modelVersionId: number, patch: ReviewPatch, body: SaveBody): Promise<RateResult> => {
      const key = pendingKey(postId, modelVersionId);
      if (!canReview || pending.has(key)) return 'ignored';

      // Lock before waiting for the first load, so isPending covers the wait and clicks can't queue.
      setPending(key, true);
      try {
        await syncFetches.get(postId)?.catch(() => undefined);
        const row = queryUtils.post.getResources
          .getData({ id: postId })
          ?.find((r) => r.modelVersionId === modelVersionId);
        if (!row?.modelId || row.modelUserId === ownerId) return 'ignored';

        const previousReview: ReviewPatch = {
          reviewId: row.reviewId,
          reviewRating: row.reviewRating,
          reviewRecommended: row.reviewRecommended,
          reviewDetails: row.reviewDetails,
          reviewCreatedAt: row.reviewCreatedAt,
        };
        const apply = (p: ReviewPatch) =>
          queryUtils.post.getResources.setData({ id: postId }, (old) =>
            old ? patchReview(old, modelVersionId, p) : old
          );
        try {
          await queryUtils.post.getResources.cancel({ id: postId });
          apply(patch);
          const input = { postId, modelId: row.modelId, modelVersionId, ...body };
          let saved = await upsert({ ...input, id: row.reviewId ?? undefined });
          // A create that lost the unique-constraint race returns the existing review untouched,
          // sometimes as a bare id row without its fields.
          const differs =
            !('recommended' in saved) ||
            saved.recommended !== body.recommended ||
            saved.rating !== body.rating ||
            (body.details !== undefined && saved.details !== body.details);
          if (!row.reviewId && differs) {
            saved = await upsert({ ...input, id: saved.id });
          }
          apply({ reviewId: saved.id, reviewCreatedAt: row.reviewCreatedAt ?? new Date() });
          await queryUtils.resourceReview.getUserResourceReview.invalidate();
          return 'saved';
        } catch (error) {
          apply(previousReview);
          showErrorNotification({
            title: 'Failed to save review',
            error: error instanceof Error ? error : new Error('Unknown error'),
          });
          return 'failed';
        }
      } finally {
        setPending(key, false);
      }
    },
    [postId, ownerId, canReview, queryUtils, upsert]
  );

  const rate = useCallback(
    (modelVersionId: number, recommended: boolean) => {
      const rating = recommended ? 5 : 1;
      return save(
        modelVersionId,
        { reviewRating: rating, reviewRecommended: recommended },
        { rating, recommended }
      );
    },
    [save]
  );

  const saveDetails = useCallback(
    async (modelVersionId: number, details: string): Promise<SaveDetailsResult> => {
      const row = queryUtils.post.getResources
        .getData({ id: postId })
        ?.find((r) => r.modelVersionId === modelVersionId);
      if (!row || row.reviewRecommended == null) return 'needs-rating';
      const { reviewRecommended: recommended } = row;
      return save(
        modelVersionId,
        { reviewDetails: details },
        { rating: row.reviewRating ?? (recommended ? 5 : 1), recommended, details }
      );
    },
    [postId, queryUtils, save]
  );

  return {
    reviews,
    byModelVersionId,
    counts,
    canReview,
    isMuted,
    isOwner,
    isPending,
    rate,
    saveDetails,
  };
}
