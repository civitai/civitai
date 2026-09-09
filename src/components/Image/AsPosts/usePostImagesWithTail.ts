import { useMemo } from 'react';
import { useApplyHiddenPreferences } from '~/components/HiddenPreferences/useApplyHiddenPreferences';
import { mergePostImages } from '~/components/Image/AsPosts/lazyPostImages';
import { POST_IMAGE_LIMIT } from '~/server/common/constants';
import { trpc } from '~/utils/trpc';

/**
 * Everything a consumer needs to fetch a gallery post's remaining images and
 * filter them the way the GALLERY did — not the way a bare `getInfinite` would.
 *
 * 🔴 The three hidden-* lists are MODEL-OWNER curation (`gallerySettings`), not the
 * viewer's own preferences, and `browsingLevel` is the gallery's `intersection`
 * (viewer level ∩ domain cap ∩ the owner's `gallerySettings.level`). Nothing
 * downstream of `image.getInfinite` re-derives any of them — `useQueryImages`
 * applies the VIEWER's prefs only — so a consumer that drops them surfaces
 * owner-hidden images and images above the owner's cap.
 *
 * Carried through the routed-dialog state so the detail modal, which renders
 * outside `ImagesAsPostsInfiniteProvider`, can filter identically to the card.
 */
export type PostTailDescriptor = {
  postId: number;
  imageCount: number;
  filters?: Record<string, unknown>;
  browsingLevel?: number;
  hiddenImageIds?: number[];
  hiddenTags?: number[];
  hiddenUsers?: number[];
};

/**
 * Seed ⊕ lazily-fetched tail for one gallery post, filtered as the gallery filters.
 *
 * Shared by the card carousel and the detail modal it seeds, so both run ONE
 * fetch policy and ONE filter policy. They also produce the same react-query key,
 * so whichever asks second is a cache hit rather than a second request.
 *
 * `enabled` is the caller's: the carousel latches it on approach to the loaded
 * edge, the modal sets it as soon as it knows its seed is partial.
 */
export function usePostImagesWithTail<T extends { id: number }>({
  seed,
  postId,
  filters,
  browsingLevel,
  hiddenImageIds,
  hiddenTags,
  hiddenUsers,
  enabled,
}: {
  seed: T[];
  enabled: boolean;
} & Omit<PostTailDescriptor, 'postId' | 'imageCount'> & {
    postId?: number | null;
  }) {
  // The tail = the WHOLE post (≤ POST_IMAGE_LIMIT), same version/browsing-level
  // filters the gallery used, so the returned set matches `imageCount`. postId
  // forces the DB path server-side (covered index, ~2ms).
  const { data, isError } = trpc.image.getInfinite.useQuery(
    {
      ...filters,
      postId: postId ?? undefined,
      browsingLevel,
      limit: POST_IMAGE_LIMIT,
      include: ['cosmetics', 'tagIds'],
    },
    {
      // `postId != null` is the explicit invariant: a null postId must never broaden
      // `getInfinite` to the model's general feed (it would append unrelated images).
      enabled: enabled && postId != null,
      trpc: { context: { skipBatch: true } },
      staleTime: 5 * 60 * 1000,
    }
  );

  const { items: filteredTail } = useApplyHiddenPreferences({
    type: 'images',
    data: data?.items,
    hiddenImages: hiddenImageIds,
    hiddenUsers,
    hiddenTags,
    browsingLevel,
  });

  const fetched = !!data;
  const images = useMemo(
    () =>
      fetched
        ? (mergePostImages(
            seed as { id: number }[],
            (filteredTail ?? []) as { id: number }[]
          ) as T[])
        : seed,
    [fetched, seed, filteredTail]
  );

  return { images, fetched, isError };
}
