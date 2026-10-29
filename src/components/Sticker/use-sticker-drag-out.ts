import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Box } from '~/components/Sticker/place-button-position';
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
 * With a mouse or pen a sticker reaches the image by being dragged onto it.
 * Pressing one creates no draft: the draft appears on the first pointer move
 * that lands inside the media box, positioned under the cursor. A plain click,
 * or a drag released outside, leaves the image untouched.
 *
 * A finger has to share the shelf with scrolling, and both go up, so direction
 * cannot tell them apart. Touch therefore goes through `touchPressStep`: a swipe
 * scrolls, a tap adds the sticker where the image is in view, and a long press
 * picks it up for the same drag a mouse gets.
 */
export function useStickerDragOut(maxScale: number) {
  // Being dragged, but not yet on the image. The only feedback during that
  // stretch, since nothing is drawn on the image until the pointer arrives.
  const [dragging, setDragging] = useState<number | null>(null);
  const endGrab = useRef<(() => void) | null>(null);

  // A gesture in flight when the surface unmounts would leave window listeners
  // behind and could drop a sticker onto an image nobody is looking at any more.
  useEffect(() => () => endGrab.current?.(), []);

  // 🔴 ON THE SHELF FROM MOUNT, NOT ADDED AT THE LONG PRESS. Browsers decide when
  // a touch starts whether its moves can be cancelled at all; a listener added
  // mid-gesture gets `cancelable: false` and the page scrolls anyway. Held
  // until the finger lifts, not just until the draft exists: the same touch
  // goes on to move the draft, still under the tile's `pan-y`.
  const holding = useRef(false);
  const shelfCleanup = useRef<(() => void) | null>(null);
  const shelfRef = useCallback((node: HTMLElement | null) => {
    shelfCleanup.current?.();
    shelfCleanup.current = null;
    if (!node) return;
    const block = (move: TouchEvent) => {
      if (holding.current && move.cancelable) move.preventDefault();
    };
    node.addEventListener('touchmove', block, { passive: false });
    shelfCleanup.current = () => node.removeEventListener('touchmove', block);
  }, []);

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

    if (event.pointerType === 'touch') return pressByTouch(cosmeticId, purchase, event);

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

  const pressByTouch = (
    cosmeticId: number,
    purchase: DraftPurchase | undefined,
    event: ReactPointerEvent
  ) => {
    endGrab.current?.();
    // Claims nothing but the emulated mouse events a tap would otherwise fire,
    // which open the shop tile's hover card; scrolling is `touch-action`'s call.
    event.preventDefault();
    const { pointerId } = event;
    const tile = event.currentTarget;
    let press = startTouchPress(event.clientX, event.clientY, event.timeStamp);

    const letGo = () => {
      holding.current = false;
      window.removeEventListener('touchend', letGo);
      window.removeEventListener('touchcancel', letGo);
    };

    const step = (input: TouchPressInput) => {
      const { next, action } = touchPressStep(press, input);
      press = next;
      if (action === 'arm') {
        setDragging(cosmeticId);
        holding.current = true;
        window.addEventListener('touchend', letGo);
        window.addEventListener('touchcancel', letGo);
        try {
          tile.setPointerCapture(pointerId);
        } catch {
          // Pointer already gone; the up or cancel still ends this.
        }
      } else if (action === 'drag' && input.type === 'move') {
        const at = pointerOverSurface(input.x, input.y);
        if (!at) return;
        // Another finger may have started a gesture during the long press.
        if (useStickerPlacementDraftStore.getState().interaction) {
          letGo();
          return teardown();
        }
        useStickerPlacementDraftStore.getState().begin(cosmeticId, at, maxScale, purchase);
        useStickerPlacementDraftStore.getState().setInteraction('move', pointerId);
        teardown();
      } else if (action === 'tap') {
        useStickerPlacementDraftStore
          .getState()
          .begin(cosmeticId, centreInView(), maxScale, purchase);
        teardown();
      } else if (action === 'abort') {
        letGo();
        teardown();
      }
    };

    const onMove = (move: PointerEvent) => {
      if (move.pointerId === pointerId)
        step({ type: 'move', x: move.clientX, y: move.clientY, time: move.timeStamp });
    };
    const onUp = (up: PointerEvent) => {
      if (up.pointerId === pointerId) step({ type: 'up', time: up.timeStamp });
    };
    const onCancel = (cancel: PointerEvent) => {
      if (cancel.pointerId === pointerId) step({ type: 'cancel' });
    };
    const timer = window.setTimeout(() => step({ type: 'timer' }), LONG_PRESS_MS);

    const teardown = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      endGrab.current = null;
      setDragging(null);
    };

    endGrab.current = teardown;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  };

  return { grab, dragging, shelfRef };
}

/** How long a still finger has to rest on a sticker to pick it up. */
export const LONG_PRESS_MS = 350;
/** Longest press that still counts as a tap. */
export const TAP_MAX_MS = 300;
/** Movement under this is a finger settling, not a swipe. */
export const TOUCH_SLOP_PX = 8;

type TouchPress = {
  phase: 'pressed' | 'armed' | 'over';
  x: number;
  y: number;
  time: number;
};

export type TouchPressInput =
  | { type: 'move'; x: number; y: number; time: number }
  | { type: 'up'; time: number }
  | { type: 'cancel' }
  | { type: 'timer' };

export const startTouchPress = (x: number, y: number, time: number): TouchPress => ({
  phase: 'pressed',
  x,
  y,
  time,
});

/**
 * What a finger on a shelf sticker means, one event at a time. Pure so the
 * three readings — swipe, tap, long press — are pinned without a touchscreen.
 */
export function touchPressStep(
  press: TouchPress,
  input: TouchPressInput
): { next: TouchPress; action?: 'arm' | 'drag' | 'tap' | 'abort' } {
  if (press.phase === 'over') return { next: press };
  const over = { ...press, phase: 'over' as const };

  // The browser took the gesture as a scroll.
  if (input.type === 'cancel') return { next: over, action: 'abort' };

  if (press.phase === 'armed') {
    if (input.type === 'move') return { next: press, action: 'drag' };
    if (input.type === 'up') return { next: over, action: 'abort' };
    return { next: press };
  }

  if (input.type === 'timer') return { next: { ...press, phase: 'armed' }, action: 'arm' };
  if (input.type === 'move') {
    const moved = Math.hypot(input.x - press.x, input.y - press.y);
    return moved < TOUCH_SLOP_PX ? { next: press } : { next: over, action: 'abort' };
  }
  return input.time - press.time <= TAP_MAX_MS
    ? { next: over, action: 'tap' }
    : { next: over, action: 'abort' };
}

/**
 * Where a tapped sticker lands: the middle of the part of the image actually on
 * screen, as fractions of the image. The plain centre can be scrolled off the
 * top or sit under the tray, which reads as a tap that did nothing.
 */
export function centreOfVisible(image: Box, visible: Box): { x: number; y: number } {
  const top = Math.max(image.top, visible.top);
  const bottom = Math.min(image.bottom, visible.bottom);
  const left = Math.max(image.left, visible.left);
  const right = Math.min(image.right, visible.right);
  const width = image.right - image.left;
  const height = image.bottom - image.top;
  if (!(width > 0) || !(height > 0) || bottom <= top || right <= left) return { x: 0.5, y: 0.5 };
  return {
    x: ((left + right) / 2 - image.left) / width,
    y: ((top + bottom) / 2 - image.top) / height,
  };
}

function centreInView() {
  const { surface, tray } = useStickerPlacementDraftStore.getState();
  if (!surface) return undefined;
  const image = surface.getBoundingClientRect();
  return centreOfVisible(
    { top: image.top, bottom: image.bottom, left: image.left, right: image.right },
    {
      top: 0,
      bottom: Math.min(window.innerHeight, tray?.getBoundingClientRect().top ?? Infinity),
      left: 0,
      right: window.innerWidth,
    }
  );
}
