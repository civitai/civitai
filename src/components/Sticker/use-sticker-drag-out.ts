import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { DraftPurchase } from '~/store/sticker-placement-draft.store';
import {
  pointerOverSurface,
  useStickerPlacementDraftStore,
} from '~/store/sticker-placement-draft.store';

/**
 * Picking a sticker up off a shelf and dropping it on the image.
 *
 * Shared by the tray (stickers you own) and the shop panel (stickers you don't
 * yet), because it is one gesture with several subtleties that were each paid
 * for once already — pointer capture, refusing a second pickup mid-drag, and
 * creating nothing until the pointer is over the image. A second copy of it
 * would be a second place for those to be got wrong, and only one of the two
 * copies would be the one under test.
 *
 * A sticker reaches the image by being dragged onto it, and by nothing else.
 * Pressing one creates no draft: the draft appears on the first pointer move
 * that lands inside the media box, positioned under the cursor. A plain click,
 * or a drag released outside, leaves the image untouched.
 */
export function useStickerDragOut(maxScale: number) {
  // Being dragged, but not yet on the image. The only feedback during that
  // stretch, since nothing is drawn on the image until the pointer arrives.
  const [dragging, setDragging] = useState<number | null>(null);
  const endGrab = useRef<(() => void) | null>(null);

  // A gesture in flight when the surface unmounts would leave window listeners
  // behind and could drop a sticker onto an image nobody is looking at any more.
  useEffect(() => () => endGrab.current?.(), []);

  const grab = (cosmeticId: number, purchase?: DraftPurchase) => (event: ReactPointerEvent) => {
    // No pickup while a drag is already in flight. The layer holds one
    // gesture, so the sticker this created would be dropped on the image and
    // then never follow anything — placed, stationary, with no cue that it
    // went wrong.
    //
    // Gated on a live gesture rather than on `event.isPrimary`, which looks
    // equivalent and is not: a mouse is primary no matter how many touches are
    // down, so a trackpad pickup during a touch drag walked straight past it —
    // and a palm resting on a tablet makes the dragging finger non-primary, so
    // it silently dropped pickups that were perfectly fine.
    if (useStickerPlacementDraftStore.getState().interaction) return;

    event.preventDefault();
    endGrab.current?.();
    setDragging(cosmeticId);
    const { pointerId } = event;

    // Captured here, on the shelf's own button, for the same reason the
    // sticker captures its own: this drag ends up owned by the layer's
    // gesture, which is refused outright while another is live, so a pointerup
    // that never arrives would strand it and refuse everything after. Capture
    // makes that delivery guaranteed. Released implicitly on the up that ends
    // the drag.
    try {
      event.currentTarget.setPointerCapture(pointerId);
    } catch {
      // Pointer already gone; teardown below still runs on up/cancel.
    }

    const onMove = (move: PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      const at = pointerOverSurface(move.clientX, move.clientY);
      if (!at) return;
      useStickerPlacementDraftStore.getState().begin(cosmeticId, at, maxScale, purchase);
      // Handing the drag to the layer, which owns it from here — along with
      // the pointer holding it, so the layer arms against this finger rather
      // than whichever one moves next. Armed only once the sticker exists on
      // the image, so there is never a live move gesture with nothing to move.
      useStickerPlacementDraftStore.getState().setInteraction('move', pointerId);
      teardown();
    };

    const teardown = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', teardown);
      window.removeEventListener('pointercancel', teardown);
      endGrab.current = null;
      setDragging(null);
    };

    endGrab.current = teardown;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', teardown);
    window.addEventListener('pointercancel', teardown);
  };

  return { grab, dragging };
}
