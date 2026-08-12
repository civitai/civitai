import { useCallback, useEffect, useRef } from 'react';
import type { Gesture } from '~/components/Sticker/draft-gesture';
import { rotate } from '~/components/Sticker/draft-gesture';
import { DraftSticker } from '~/components/Sticker/DraftSticker';
import { useImagePlacementSpace } from '~/components/Sticker/placement.util';
import { useOwnedSticker } from '~/components/Sticker/sticker.util';
import { resolveTreatment } from '~/components/Sticker/treatments/sticker-treatments';
import { useStickerTreatment } from '~/components/Sticker/treatments/useStickerTreatment';
import { STICKER_PLACEMENT_MIN_SCALE, stickerMaxScale } from '~/shared/utils/sticker-placement';
import {
  pointerToSurfaceFraction,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

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
  const move = useStickerPlacementDraftStore((state) => state.move);
  const setInteraction = useStickerPlacementDraftStore((state) => state.setInteraction);
  const { sticker } = useOwnedSticker();
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

  const gesture = useRef<Gesture | null>(null);
  // Held in a ref because the pointer listener is bound once; re-binding it when
  // the space loads would drop the moves in flight at that moment.
  const maxScaleRef = useRef(maxScale);
  maxScaleRef.current = maxScale;

  // First pointer down wins until it comes up. A second finger landing on
  // another sticker used to overwrite the gesture, which sent the first finger's
  // moves to the second finger's sticker.
  //
  // Reports whether it took the gesture, so the caller can keep selection in
  // step with it. Selecting on a refused press moved the highlight and the
  // z-order onto the second finger's sticker while the first finger was still
  // dragging a different one — the sticker under your finger dropped beneath
  // the one that was not.
  //
  // A *primary* pointer always takes over, and that is the important half. A
  // flat "refuse while a gesture exists" makes a lost pointerup permanent:
  // nothing else clears the ref, so pressing the button, alt-tabbing and
  // releasing in another window — which delivers neither pointerup nor
  // pointercancel — would refuse every drag, resize, rotate and tray pickup for
  // the rest of the session, recoverable only by removing every draft. A second
  // finger is never primary while the first is down, so refusing only
  // non-primary keeps that closed while letting a mouse or a fresh first touch
  // heal a stranded gesture on the next press.
  const onGesture = useCallback((next: Gesture) => {
    if (gesture.current && !next.isPrimary) return false;
    gesture.current = next;
    useStickerPlacementDraftStore.getState().setInteraction(next.mode);
    return true;
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // Read through getState rather than subscribing: this listener runs on
      // every pointer move, and re-binding it whenever a draft changes would
      // drop the moves that land during the swap.
      const active = gesture.current;
      // Only the pointer that started it drives it. Every other stream on the
      // screen is somebody else's finger.
      if (!active || event.pointerId !== active.pointerId) return;

      const point = pointerToSurfaceFraction(event.clientX, event.clientY);
      // By id, not by selection: a press selects and drags in one gesture, and a
      // selection that changed under a drag in flight would otherwise start
      // moving a sticker nobody is touching.
      const current = useStickerPlacementDraftStore
        .getState()
        .drafts.find((draft) => draft.id === active.draftId);
      if (!point || !current) return;

      const { bounds } = point;
      const pointerX = event.clientX - bounds.left;
      const pointerY = event.clientY - bounds.top;

      if (active.mode === 'move') {
        move(active.draftId, { x: point.x + active.offsetX, y: point.y + active.offsetY });
        return;
      }

      if (active.mode === 'rotate') {
        const dx = pointerX - current.x * bounds.width;
        const dy = pointerY - current.y * bounds.height;
        // The knob sits above the sticker, so straight up is zero rather than
        // atan2's zero, which points right.
        move(active.draftId, { rotation: (Math.atan2(dy, dx) * 180) / Math.PI + 90 });
        return;
      }

      // Resize holds the opposite corner still, the way every other editor does.
      // Measured in the sticker's own frame, so dragging a corner of a rotated
      // sticker grows it along its own edge rather than the screen's.
      const local = rotate(pointerX - active.anchorX, pointerY - active.anchorY, -current.rotation);
      const width = Math.min(
        Math.max(Math.abs(local.x), STICKER_PLACEMENT_MIN_SCALE * bounds.width),
        maxScaleRef.current * bounds.width
      );
      // Clamped first, then the centre is derived from the clamped size — the
      // other order lets the anchor drift once a drag hits either bound.
      const centre = rotate(
        (active.sx * width) / 2,
        (active.sy * width) / active.aspect / 2,
        current.rotation
      );

      move(active.draftId, {
        scale: width / bounds.width,
        x: (active.anchorX + centre.x) / bounds.width,
        y: (active.anchorY + centre.y) / bounds.height,
      });
    };

    // Ends for the pointer that owns it, or for any primary pointer — an
    // unconditional clear let a second finger lifting anywhere kill a live drag,
    // but an owner-only clear would strand the gesture forever if its own
    // pointerup never arrives.
    const onUp = (event: PointerEvent) => {
      if (gesture.current && event.pointerId !== gesture.current.pointerId && !event.isPrimary)
        return;
      gesture.current = null;
      setInteraction(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [move, setInteraction]);

  // Picking a sticker up from the tray starts a move with no offset — the press
  // happened outside the image, so there is no grab point to preserve. The draft
  // it belongs to is the one `begin` just appended and selected.
  const trayInteraction = useStickerPlacementDraftStore((state) => state.interaction);
  const trayPointerId = useStickerPlacementDraftStore((state) => state.interactionPointerId);
  useEffect(() => {
    if (trayInteraction !== 'move' || gesture.current || !selectedDraftId || trayPointerId == null)
      return;
    gesture.current = {
      draftId: selectedDraftId,
      pointerId: trayPointerId,
      // The tray refuses a pickup while any gesture is live, so the pointer that
      // got here is the one that owns the drag.
      isPrimary: true,
      mode: 'move',
      offsetX: 0,
      offsetY: 0,
    };
  }, [trayInteraction, selectedDraftId, trayPointerId]);

  return (
    <>
      {drafts.map((draft) => {
        const art = sticker.find((option) => option.id === draft.cosmeticId);
        if (!art) return null;

        return (
          <DraftSticker
            key={draft.id}
            draft={draft}
            art={art}
            selected={draft.id === selectedDraftId}
            dressed={dressed}
            price={space?.price ?? 0}
            ownerShare={space?.ownerShare}
            ownerUsername={space?.ownerUsername}
            onGesture={onGesture}
          />
        );
      })}
    </>
  );
}
