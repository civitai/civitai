import { useCallback, useEffect, useRef } from 'react';
import type { Gesture } from '~/components/Sticker/draft-gesture';
import { knobRotation, rotate } from '~/components/Sticker/draft-gesture';
import { capScaleFromWidth, STICKER_PLACEMENT_MIN_SCALE } from '~/shared/utils/sticker-placement';
import { pointerToSurfaceFraction, useDraftStoreHook } from '~/store/sticker-placement-draft.store';

/**
 * The one window-bound gesture for every draft on the placement surface: move,
 * corner resize and the rotate knob. Returns the `onGesture` each `DraftSticker`
 * calls on pointer down. `maxScale` caps a resize.
 */
export function useDraftGestures(maxScale: number) {
  const useStore = useDraftStoreHook();
  const move = useStore((state) => state.move);
  const setInteraction = useStore((state) => state.setInteraction);
  const selectedDraftId = useStore((state) => state.selectedDraftId);

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
  // Refused outright while one is live, which is only safe because the owning
  // pointer is captured: its up or cancel is guaranteed to arrive, so a gesture
  // cannot be stranded and this cannot become a permanent refusal.
  const onGesture = useCallback(
    (next: Gesture) => {
      if (gesture.current) return false;
      gesture.current = next;
      useStore.getState().setInteraction(next.mode);
      return true;
    },
    [useStore]
  );

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      // Read through getState rather than subscribing: this listener runs on
      // every pointer move, and re-binding it whenever a draft changes would
      // drop the moves that land during the swap.
      const active = gesture.current;
      // Only the pointer that started it drives it. Every other stream on the
      // screen is somebody else's finger.
      if (!active || event.pointerId !== active.pointerId) return;

      const point = pointerToSurfaceFraction(event.clientX, event.clientY, useStore);
      // By id, not by selection: a press selects and drags in one gesture, and a
      // selection that changed under a drag in flight would otherwise start
      // moving a sticker nobody is touching.
      const current = useStore.getState().drafts.find((draft) => draft.id === active.draftId);
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
        move(active.draftId, { rotation: knobRotation(dx, dy, active.knobBelow) });
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
        scale: capScaleFromWidth(width, bounds.width, maxScaleRef.current),
        x: (active.anchorX + centre.x) / bounds.width,
        y: (active.anchorY + centre.y) / bounds.height,
      });
    };

    // The owning pointer and nothing else. Any other pointer lifting used to end
    // a live drag; letting a primary one end it did the same thing for a thumb
    // resting on a tablet. Capture is what makes strict ownership safe — the
    // owner's up or cancel always arrives, and `lostpointercapture` covers the
    // case where the browser takes capture away instead.
    const onUp = (event: PointerEvent) => {
      if (!gesture.current || event.pointerId !== gesture.current.pointerId) return;
      gesture.current = null;
      setInteraction(null);
    };

    // The backstop for the one case capture does not cover: capture lives on an
    // element, and an element can be removed mid-gesture — the tray button a
    // pickup captured, if the panel is closed while the drag is still running.
    // The browser then releases capture and fires `lostpointercapture` at the
    // detached node, which has no path to window, so this listener never hears
    // it and the drag silently reverts to needing a volunteered pointerup.
    // Refusal is unconditional, so losing that up would lock every later
    // gesture. Leaving the window is how an up goes missing in practice, and
    // ending a drag you have navigated away from is the right outcome anyway.
    // ⚠️ Bound on `window` in the BUBBLE phase, and that is what makes it safe
    // rather than catastrophic. `blur` does not bubble, so this fires only when
    // the window itself loses focus. Registered with `{capture: true}`, or on
    // `document`, it would instead see every focus change on the page — a
    // select popup, a focus trap, one input handing off to another — and kill
    // the drag on each one.
    const onBlur = () => {
      if (!gesture.current) return;
      gesture.current = null;
      setInteraction(null);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('lostpointercapture', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('lostpointercapture', onUp);
      window.removeEventListener('blur', onBlur);
      // Nothing can be dragging once this layer is gone, and `interaction` is
      // what the tray reads to decide whether a pickup is allowed. Leaving it
      // set would refuse the next pickup with no drag to justify it.
      gesture.current = null;
      setInteraction(null);
    };
    // ⚠️ Both deps are zustand actions with permanently stable identity, and
    // this cleanup now writes shared state — it is the only thing that unlocks
    // a gesture when the layer goes away. Adding a dep that actually changes
    // (`maxScale`, `drafts`, `targetImageId`) turns the cleanup into a
    // per-render `gesture.current = null`, which kills any drag in progress the
    // moment anything re-renders. Read values through refs instead.
  }, [move, setInteraction, useStore]);

  // Picking a sticker up from the tray starts a move with no offset — the press
  // happened outside the image, so there is no grab point to preserve. The draft
  // it belongs to is the one `begin` just appended and selected.
  const trayInteraction = useStore((state) => state.interaction);
  const trayPointerId = useStore((state) => state.interactionPointerId);
  useEffect(() => {
    if (trayInteraction !== 'move' || gesture.current || !selectedDraftId || trayPointerId == null)
      return;
    gesture.current = {
      draftId: selectedDraftId,
      pointerId: trayPointerId,
      mode: 'move',
      offsetX: 0,
      offsetY: 0,
    };
  }, [trayInteraction, selectedDraftId, trayPointerId]);

  return onGesture;
}
