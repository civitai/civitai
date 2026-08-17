import { useQueryClient } from '@tanstack/react-query';
import { getQueryKey } from '@trpc/react-query';
import { useCallback, useMemo } from 'react';
import { freeRefusalMessage, freeRefusalOutcome } from '~/components/Sticker/free-offer';
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
  /**
   * Placed against the creator's free capacity, so nothing was paid for it.
   *
   * On the listing rather than derived from `amount`, because every surface that
   * reads this decides what to SAY about money — what a decline returns, why a
   * removal is locked — and a zero is a number rather than the fact that answers
   * that.
   */
  free: boolean;
  data: StickerPlacementData;
  /**
   * `Date` over superjson, a string out of anything that stringified the cache
   * on the way past. Both are accepted rather than normalised on arrival
   * because the only readers pass it to `new Date()` anyway, and a cast that
   * claims `Date` for a value that is a string reads correct and compares
   * wrong.
   */
  placedAt: Date | string;
  isPending: boolean;
  /**
   * Whether this placement carries a note the viewer may read. The text itself
   * is not in the listing — that runs for every image on a feed page — and comes
   * with the hover card instead.
   */
  hasComment: boolean;
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

  const { data, isLoading, isError } = trpc.placement.getStickerPlacements.useQuery(
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

  // `isError` alongside, for the same reason the counts hook carries it: a
  // failed fetch and an image nobody has stickered are both an empty map, and a
  // surface that reads "no stickers here" off the first one is saying something
  // it does not know.
  return { byImage, isLoading, isError };
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

  const { data, isLoading, isError } = trpc.placement.getStickerPlacementCounts.useQuery(
    { imageIds: ids },
    { enabled: enabled && ids.length > 0, staleTime: 60_000 }
  );

  // `isLoading` and `isError` alongside the counts because zero, not-yet-known
  // and never-arriving are three different states with different affordances,
  // and `data ?? {}` collapses all three: an image with stickers reads as empty
  // both before the query settles and after it fails.
  return { counts: (data ?? {}) as Record<number, number>, isLoading, isError };
}

/**
 * The removed row out of one cached list, and the image to decrement — which is
 * `undefined` unless the row was **approved**.
 *
 * `getStickerPlacementCounts` is approved-only, so a pending row was never in
 * it. Decrementing for one would leave the badge a sticker short of what is
 * drawn, and the reaction bar adds the viewer's own pending rows to the count.
 * Exported and pure so this rule is testable without a query client.
 *
 * A chunk with no hit yields `undefined` rather than its own array back.
 * `setQueryData` writes any defined value it is handed and stamps a fresh
 * `dataUpdatedAt` even for an identical reference — and the batch provider
 * memoises on exactly that — so `undefined` is the only return that leaves an
 * untouched chunk genuinely untouched.
 */
export function dropPlacementFromList(
  placements: PlacedSticker[] | undefined,
  placementId: number
) {
  const hit = placements?.find((placement) => placement.id === placementId);
  if (!hit || !placements) return { placements: undefined, countedOn: undefined };

  return {
    placements: placements.filter((placement) => placement.id !== placementId),
    countedOn: hit.isPending ? undefined : hit.imageId,
  };
}

/** One off the count for that image, and only if there is one to take. */
export function decrementPlacementCount(
  counts: Record<number, number> | undefined,
  imageId: number
) {
  const current = counts?.[imageId];
  if (!counts || !current) return counts;
  return { ...counts, [imageId]: current - 1 };
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
 * That is reachable from the image detail view too, not only from a feed: the
 * detail opens as a routed dialog *over* the feed, so the provider and every
 * chunk it holds stay mounted behind it.
 *
 * The detail query IS invalidated, by id: it is one request, and the surfaces
 * that offer removal read it to decide whether the placement is still live.
 */
export function useForgetStickerPlacement() {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();

  return useCallback(
    async (placementId: number) => {
      let countedOn: number | undefined;

      queryClient.setQueriesData<PlacedSticker[]>(
        { queryKey: getQueryKey(trpc.placement.getStickerPlacements), exact: false },
        (placements) => {
          const result = dropPlacementFromList(placements, placementId);
          // Assigned only on the chunk that held the row; every other chunk
          // returns `undefined`, which skips the write and leaves this alone.
          if (result.countedOn !== undefined) countedOn = result.countedOn;
          return result.placements;
        }
      );

      if (countedOn !== undefined)
        queryClient.setQueriesData<Record<number, number>>(
          { queryKey: getQueryKey(trpc.placement.getStickerPlacementCounts), exact: false },
          (counts) => decrementPlacementCount(counts, countedOn as number)
        );

      await utils.placement.getStickerPlacementDetail.invalidate({ placementId });
    },
    [queryClient, utils]
  );
}

/**
 * Where the viewer stands against the free tier on one image.
 *
 * Its own query rather than folded into the space: the space is public and
 * cached per image, and this is per viewer — merging them would make one
 * person's allowance part of a payload every other viewer of that image shares.
 *
 * **A listing.** Whatever it says, the claim re-decides all of it under a lock,
 * so this only ever chooses which offer to show — never whether one is allowed.
 */
export function useFreePlacementStanding(imageId?: number) {
  const { data, isLoading } = trpc.placement.getFreeStanding.useQuery(
    { surface: 'sticker', targetType: 'image', targetId: imageId as number },
    { enabled: !!imageId, staleTime: 60_000 }
  );

  return { standing: data, isLoading };
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
export function useCreateStickerPlacement(
  draftId: string,
  /**
   * Called when a free claim was refused, so the control can settle on the paid
   * option. Losing the last slot to someone else is an ordinary race rather than
   * a fault, and leaving the control on an offer that no longer exists would
   * make the next press fail the same way.
   */
  onFreeRefused?: () => void
) {
  const utils = trpc.useUtils();
  const cancelDraft = useStickerPlacementDraftStore((state) => state.cancelDraft);

  return trpc.placement.createSticker.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Sticker placed',
        message:
          result.status === 'pending'
            ? 'Only you can see it until the creator approves it.'
            : 'It is live on the image now.',
      });
      await Promise.all([
        utils.placement.invalidate(),
        // A placement spends a use, and the tray reads the remaining count from
        // a different router. This used to be covered by accident: success
        // ended the session, which unmounted the tray, so the count refetched
        // on the next open. Now the tray survives a purchase, and without this
        // it keeps showing the pre-purchase number — the count even climbs back
        // up as the bought draft leaves `drafts` and stops being subtracted.
        // You could then lay out and pay for a sticker you have no use left
        // for, and only be refused by the server after the Buzz confirmation.
        utils.cosmetic.getStickerBalances.invalidate(),
      ]);
      // Only the one that was bought. The others are still being arranged, and
      // ending the session would take them with it — which is the bug this
      // whole flow exists to avoid, arrived at from the other direction. The
      // draft has to go either way: it is now a real placement, and leaving it
      // would draw the same sticker twice with one of them uncommitted.
      cancelDraft(draftId);
    },
    onError: async (error, variables) => {
      if (!variables.free)
        return showErrorNotification({
          title: "Couldn't place that sticker",
          error: new Error(error.message),
        });

      // Re-read before saying anything. The refusal does not name which of the
      // three free-tier rules stopped it, and the numbers this control rendered
      // are stale by construction — so the honest sentence comes from fresh
      // state, not from the server's prose. The invalidation is also what makes
      // the free option disappear on its own where it genuinely has.
      const target = {
        surface: 'sticker' as const,
        targetType: 'image' as const,
        targetId: variables.imageId,
      };
      await Promise.all([
        utils.placement.getSpace.invalidate(target),
        // Unkeyed, deliberately. The daily allowance is one placement a day
        // across the whole site, so a target-scoped invalidation leaves every
        // OTHER image's cached standing showing an allowance that is gone — and
        // that stale number is what a control reads to decide whether to offer
        // free at all. The space is per image and stays keyed.
        utils.placement.getFreeStanding.invalidate(),
      ]);

      // 🔴 Only a refusal the re-read can account for falls back to paid. The
      // free path refuses plenty of things that have nothing to do with the free
      // tier — a block, a suspension, self-placement, a sticker over the
      // creator's size limit — each arriving with a message written for the
      // person who hit it. Answering all of them with "someone took the last
      // slot" throws those away and offers a paid button that fails the same
      // way, which is the worse half: the remedy is wrong, not just the reason.
      // The branch itself is `freeRefusalOutcome`, where it is testable.
      const outcome = freeRefusalOutcome(
        freeRefusalMessage(
          utils.placement.getFreeStanding.getData(target),
          utils.placement.getSpace.getData(target)
        ),
        error.message
      );

      // Paid rather than an error where free ran out, which is the cross-surface
      // rule: the placement they arranged is still available, it just costs Buzz
      // now, and starting over would throw away the arrangement over a race that
      // took nothing from them.
      if (outcome.fallBackToPaid) onFreeRefused?.();
      showErrorNotification({ title: outcome.title, error: new Error(outcome.message) });
    },
  });
}
