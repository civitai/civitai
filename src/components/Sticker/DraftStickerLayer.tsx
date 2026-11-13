import { useCallback, useMemo } from 'react';
import { DraftSticker } from '~/components/Sticker/DraftSticker';
import { StickerMotionGuides } from '~/components/Sticker/StickerMotionGuides';
import { useDraftGestures } from '~/components/Sticker/useDraftGestures';
import { freeOfferFor } from '~/components/Sticker/free-offer';
import {
  useFreePlacementStanding,
  useImagePlacementSpace,
} from '~/components/Sticker/placement.util';
import {
  allocateDraftEntitlements,
  unownedGateFor,
  useOwnedSticker,
  useStickerCosmetics,
  draftedCosmeticIds,
  useStickerRefill,
} from '~/components/Sticker/sticker.util';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { useStickerTreatment } from '~/components/Sticker/treatments/useStickerTreatment';
import { stickerMaxScale } from '~/shared/utils/sticker-placement';
import { useStickerPlacementDraftStore } from '~/store/sticker-placement-draft.store';

/**
 * The stickers being positioned on one image, before they are paid for.
 *
 * Several at once: arranging a few and then deciding which to keep is how this
 * is actually used, and dragging a second one out used to delete the first. Each
 * draws itself; this owns the one thing they cannot own separately, which is the
 * gesture — a drag is bound to the window, and one listener that knows which
 * draft it belongs to beats one listener per sticker.
 *
 * Drag a body to move, a corner to resize, the knob above it to rotate, and buy
 * it with the button beneath it. The button lives inside the same transformed
 * element, so it travels and rotates with the sticker rather than sitting in a
 * panel across the screen from the thing it is buying.
 */
export function DraftStickerLayer() {
  const drafts = useStickerPlacementDraftStore((state) => state.drafts);
  const selectedDraftId = useStickerPlacementDraftStore((state) => state.selectedDraftId);
  const targetImageId = useStickerPlacementDraftStore((state) => state.targetImageId);
  const playheadMs = useStickerPlacementDraftStore((state) => state.playheadMs);
  // Previewing shows the stickers as viewers see them, so no guides.
  const showGuides = useStickerPlacementDraftStore(
    (state) => !state.videoPlaying && !state.previewing && !state.trayOpen
  );
  const { sticker } = useOwnedSticker();
  // A draft dragged out of the shop is a sticker the placer does not own yet, so
  // its artwork is not in `useOwnedSticker` — without this it renders nothing and
  // the drag looks like it failed.
  const unownedIds = useMemo(
    () => drafts.filter((draft) => draft.purchase).map((draft) => draft.cosmeticId),
    [drafts]
  );
  const { sticker: shopArt } = useStickerCosmetics(unownedIds);
  const { space } = useImagePlacementSpace(targetImageId ?? undefined);
  // Resolved once for the layer rather than per draft: `useStickerTreatment`
  // reads the user's settings and the router, so a subscription per sticker is
  // N context consumers re-rendering on every routed dialog. `isPending` is
  // false because a draft is not a placement yet — it carries its own dashed
  // outline, and dressing it as pending would claim a decision is waiting.
  const treatment = useStickerTreatment();
  const dressed = resolveTreatment({ treatment, surface: 'detail', isPending: false });
  // The creator's ceiling, so a resize handle stops where the mutation would
  // refuse. The refusal is still on the server — this only means nobody has to
  // discover it by being told no after a drag.
  const maxScale = stickerMaxScale(space?.settings);

  // Resolved once for the layer, for the same reason the treatment is: one query
  // answering a question about the image and the viewer, where a subscription
  // per sticker would be N observers refetching through an arrangement.
  const { standing } = useFreePlacementStanding(targetImageId ?? undefined);
  const freeOffer = freeOfferFor(space, standing);

  const currentUser = useCurrentUser();
  const { data: balances } = trpc.cosmetic.getStickerBalances.useQuery(undefined, {
    enabled: !!currentUser && targetImageId != null,
  });
  // Only what has been dragged out — an offer for a sticker nobody has drafted is
  // an answer to a question not yet asked.
  const draftedIds = useMemo(() => draftedCosmeticIds(drafts), [drafts]);
  const refillFor = useStickerRefill(draftedIds);

  const paidDraftIds = useStickerPlacementDraftStore((state) => state.paidDraftIds);
  const duplicateDraft = useStickerPlacementDraftStore((state) => state.duplicateDraft);

  const entitlements = useMemo(
    () => allocateDraftEntitlements({ drafts, balances, freeAvailable: !!freeOffer, paidDraftIds }),
    [drafts, balances, freeOffer, paidDraftIds]
  );

  const onDuplicate = useCallback(
    (id: string) => {
      const current = useStickerPlacementDraftStore.getState().drafts;
      const source = current.find((draft) => draft.id === id);
      if (!source) return null;

      // Only the sticker-not-owned-yet gate travels with a copy. Whether an
      // owned sticker still has a use is decided across the whole set on every
      // render — storing that answer here is exactly what froze it before.
      return duplicateDraft(id, unownedGateFor(source));
    },
    [duplicateDraft]
  );

  const onGesture = useDraftGestures(maxScale);
  const artFor = (cosmeticId: number) =>
    sticker.find((option) => option.id === cosmeticId) ?? shopArt.get(cosmeticId);
  const selectedDraft = drafts.find((draft) => draft.id === selectedDraftId);
  const selectedArt = selectedDraft && artFor(selectedDraft.cosmeticId);

  return (
    <>
      {showGuides && selectedDraft && selectedArt && (
        <StickerMotionGuides draft={selectedDraft} art={selectedArt} playheadMs={playheadMs} />
      )}
      {drafts.map((draft) => {
        const art = artFor(draft.cosmeticId);
        if (!art) return null;

        return (
          <DraftSticker
            key={draft.id}
            draft={draft}
            art={art}
            selected={draft.id === selectedDraftId}
            dressed={dressed}
            price={space?.price ?? 0}
            creatorMaxScale={maxScale}
            ownerShare={space?.ownerShare}
            ownerUsername={space?.ownerUsername}
            onGesture={onGesture}
            onDuplicate={onDuplicate}
            // The sticker-not-owned-yet gate belongs to the draft; the
            // is-there-a-use-left gate belongs to the set and is decided above.
            purchase={
              draft.purchase ??
              (entitlements.get(draft.id)?.covered
                ? undefined
                : refillFor(
                    draft.cosmeticId,
                    sticker.find((option) => option.id === draft.cosmeticId)?.pricePerUse
                  ))
            }
            // Exactly one draft can take the free placement — it is once per
            // image — so the offer goes to that one rather than to all of them.
            freeOffer={entitlements.get(draft.id)?.free ? freeOffer : null}
          />
        );
      })}
    </>
  );
}
