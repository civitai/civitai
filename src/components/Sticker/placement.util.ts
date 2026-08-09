import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useCallback, useMemo } from 'react';
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

/**
 * Drops one placement out of whatever is already cached, without refetching.
 *
 * `utils.placement.invalidate()` is the obvious call and the wrong one on a
 * feed: the batch provider holds two queries per 100 cards, so a moderator
 * removing a sticker after scrolling a couple of thousand images would refetch
 * forty of them — and tRPC request batching is off by default, so that is forty
 * HTTP requests for a change that affects one row. The removal is authoritative
 * server-side; the client only has to stop drawing it.
 *
 * The detail query IS invalidated, by id: it is one request, and the surfaces
 * that offer removal read it to decide whether the placement is still live.
 */
export function useForgetStickerPlacement() {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();

  return useCallback(
    async (placementId: number) => {
      let imageId: number | undefined;

      queryClient.setQueriesData<PlacedSticker[]>(
        { queryKey: getQueryKey(trpc.placement.getStickerPlacements), exact: false },
        (placements) => {
          const hit = placements?.find((placement) => placement.id === placementId);
          if (!hit) return placements;
          imageId = hit.imageId;
          return placements?.filter((placement) => placement.id !== placementId);
        }
      );

      // Only when the placement was actually in a cached list, and only for its
      // own image — the count is approved-only, so a pending row was never in it
      // and decrementing would show one fewer sticker than are drawn.
      if (imageId !== undefined)
        queryClient.setQueriesData<Record<number, number>>(
          { queryKey: getQueryKey(trpc.placement.getStickerPlacementCounts), exact: false },
          (counts) => {
            const current = counts?.[imageId as number];
            if (!counts || !current) return counts;
            return { ...counts, [imageId as number]: current - 1 };
          }
        );

      await utils.placement.getStickerPlacementDetail.invalidate({ placementId });
    },
    [queryClient, utils]
  );
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
