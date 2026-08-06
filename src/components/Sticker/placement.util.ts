import { useMemo } from 'react';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';
import type { StickerPlacementData } from '~/shared/utils/sticker-placement';

export type PlacedSticker = {
  id: number;
  imageId: number;
  placerId: number;
  ownerId: number;
  status: string;
  amount: number;
  data: StickerPlacementData;
  isPending: boolean;
};

/**
 * Placements for a set of images, in one request for the whole surface.
 *
 * Batched the same way the sticker artwork is, and for the same reason: tRPC
 * request batching is behind a flag that is off by default, so a per-card query
 * is a per-card HTTP request.
 */
export function useStickerPlacements(imageIds: number[], enabled = true) {
  const ids = useMemo(
    () => [...new Set(imageIds)].sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(',')]
  );

  const { data, isLoading } = trpc.placement.getStickerPlacements.useQuery(
    { imageIds: ids },
    { enabled: enabled && ids.length > 0, staleTime: 60_000 }
  );

  const byImage = useMemo(() => {
    const map = new Map<number, PlacedSticker[]>();
    for (const placement of (data as PlacedSticker[] | undefined) ?? []) {
      const list = map.get(placement.imageId) ?? [];
      list.push(placement);
      map.set(placement.imageId, list);
    }
    return map;
  }, [data]);

  return { byImage, isLoading };
}

/**
 * Approved counts for the reaction-bar entry.
 *
 * A separate query from the placements themselves so a feed can show "3
 * stickers" without fetching their positions and artwork — the count is what
 * decides whether the affordance appears at all, and most viewers never reveal.
 */
export function useStickerPlacementCounts(imageIds: number[], enabled = true) {
  const ids = useMemo(
    () => [...new Set(imageIds)].sort((a, b) => a - b),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageIds.join(',')]
  );

  const { data } = trpc.placement.getStickerPlacementCounts.useQuery(
    { imageIds: ids },
    { enabled: enabled && ids.length > 0, staleTime: 60_000 }
  );

  return (data ?? {}) as Record<number, number>;
}

export function useImagePlacementSpace(imageId?: number) {
  const { data, isLoading } = trpc.placement.getSpace.useQuery(
    { surface: 'sticker', targetType: 'image', targetId: imageId as number },
    { enabled: !!imageId, staleTime: 60_000 }
  );

  return { space: data, isLoading };
}

/**
 * Placing a sticker, shared by whatever triggers it.
 *
 * One hook rather than the mutation inline, so the tray and the sticker's own
 * buy button cannot drift into two versions of what happens on success.
 */
export function useCreateStickerPlacement() {
  const utils = trpc.useUtils();
  const close = useStickerPlacementDraftStore((state) => state.close);

  return trpc.placement.createSticker.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Sticker placed',
        message:
          result.status === 'pending'
            ? 'Only you can see it until the creator approves it.'
            : 'It is live on the image now.',
      });
      await utils.placement.invalidate();
      close();
    },
    onError: (error) =>
      showErrorNotification({
        title: "Couldn't place that sticker",
        error: new Error(error.message),
      }),
  });
}
