import { isEqual, uniqWith } from 'lodash-es';
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
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
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const pendingKey = (postId: number, modelVersionId: number) => `${postId}:${modelVersionId}`;

export type RateResult = 'saved' | 'ignored' | 'failed';
export type SaveDetailsResult = RateResult | 'needs-rating';

type SaveBody = { rating: number; recommended: boolean; details?: string };

/**
 * The current user's reviews of a post's resources, keyed by model version and shared by every
 * consumer through the `post.getResources` cache.
 */
export function usePostResourceReviews({ postId, ownerId }: { postId: number; ownerId: number }) {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const isMuted = currentUser?.muted ?? false;
  // A moderator editing someone else's post must not review under their own account.
  const canReview = !isMuted && !!currentUser && currentUser.id === ownerId;

  const storeImages = usePostEditStore((state) => state.images);
  const imageResources = useMemo(
    () =>
      uniqWith(
        storeImages
          .map((x) => (x.type === 'added' ? x.data : undefined))
          .filter(isDefined)
          .flatMap((x) => x.resourceHelper)
          .map(({ modelVersionId, name }) => ({ modelVersionId, name })),
        isEqual
      ),
    [storeImages]
  );

  const { data, refetch, isRefetching } = trpc.post.getResources.useQuery(
    { id: postId },
    { enabled: false }
  );
  const reviews = useMemo(() => dedupeByModelVersion(data ?? []), [data]);
  const byModelVersionId = useMemo(
    () => new Map(reviews.map((r) => [r.modelVersionId as number, r])),
    [reviews]
  );
  const counts = useMemo(() => countReviews(reviews), [reviews]);

  // Refetch when the post's image resources change, as the old sidebar list did.
  useEffect(() => {
    const shouldRefetch = imageResources.length !== (data ?? []).length && canReview;
    if (shouldRefetch && !isRefetching) refetch();
  }, [imageResources, canReview, refetch, isRefetching]); //eslint-disable-line

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
      const row = queryUtils.post.getResources
        .getData({ id: postId })
        ?.find((r) => r.modelVersionId === modelVersionId);
      if (!canReview || !row?.modelId || pending.has(key)) return 'ignored';

      setPending(key, true);
      await queryUtils.post.getResources.cancel({ id: postId });
      const previous = queryUtils.post.getResources.getData({ id: postId });
      const apply = (p: ReviewPatch) =>
        queryUtils.post.getResources.setData({ id: postId }, (old) =>
          old ? patchReview(old, modelVersionId, p) : old
        );
      apply(patch);
      try {
        const input = { postId, modelId: row.modelId, modelVersionId, ...body };
        let saved = await upsert({ ...input, id: row.reviewId ?? undefined });
        // A create that lost the unique-constraint race returns the existing review untouched.
        if (!row.reviewId && saved.recommended !== body.recommended) {
          saved = await upsert({ ...input, id: saved.id });
        }
        apply({ reviewId: saved.id, reviewCreatedAt: row.reviewCreatedAt ?? new Date() });
        await queryUtils.resourceReview.getUserResourceReview.invalidate();
        return 'saved';
      } catch (error) {
        queryUtils.post.getResources.setData({ id: postId }, previous);
        showErrorNotification({
          title: 'Failed to save review',
          error: error instanceof Error ? error : new Error('Unknown error'),
        });
        return 'failed';
      } finally {
        setPending(key, false);
      }
    },
    [postId, canReview, queryUtils, upsert]
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

  return { reviews, byModelVersionId, counts, canReview, isMuted, isPending, rate, saveDetails };
}
