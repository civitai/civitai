import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TouchEvent } from 'react';

/** Movement before a touch is read as a swipe or a scroll. */
export const SWIPE_SLOP_PX = 10;
/** Letting go this far across the panel goes back. */
export const SWIPE_COMMIT_FRACTION = 0.35;
/** A flick this fast (px per ms) goes back from a shorter distance. */
export const SWIPE_FLICK_VELOCITY = 0.5;
export const SWIPE_FLICK_MIN_PX = 24;

const VELOCITY_WINDOW_MS = 100;
const SLIDE_MS = 220;
const SLIDE_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
/** The level behind trails the panel by this share of its width, as in a native stack. */
const PARALLAX_PERCENT = 25;

type Point = { x: number; y: number; t: number };

/** Mostly horizontal and rightward is a swipe back; anything else past the slop is a scroll. */
export function swipeIntent(dx: number, dy: number): 'back' | 'scroll' | undefined {
  if (Math.hypot(dx, dy) < SWIPE_SLOP_PX) return undefined;
  return dx > 0 && Math.abs(dy) * 2 <= dx ? 'back' : 'scroll';
}

/** Horizontal speed (px per ms) over the last moments before `now`; 0 once the finger has rested. */
export function releaseVelocity(samples: Point[], now: number) {
  const recent = samples.filter((sample) => now - sample.t <= VELOCITY_WINDOW_MS);
  if (recent.length < 2) return 0;
  const first = recent[0];
  const last = recent[recent.length - 1];
  return last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
}

export function shouldGoBack({
  dx,
  width,
  velocity,
}: {
  dx: number;
  width: number;
  velocity: number;
}) {
  if (velocity <= -SWIPE_FLICK_VELOCITY) return false;
  if (dx >= width * SWIPE_COMMIT_FRACTION) return true;
  return velocity >= SWIPE_FLICK_VELOCITY && dx >= SWIPE_FLICK_MIN_PX;
}

type Gesture = {
  start: Point;
  samples: Point[];
  intent: 'back' | 'scroll' | undefined;
  width: number;
  offset: number;
};

/**
 * Drag the nested panel with the finger, the level behind showing, and settle it on release: past
 * `shouldGoBack` it slides off and `onBack` runs, short of it the panel snaps back. Attach `ref` to the
 * panel and `behindRef` to the layer rendered while `dragging`, and spread `bind` on the panel. The
 * panel needs `touch-action: pan-y`, so a vertical pan still scrolls and the browser leaves the
 * horizontal one to this.
 */
export function useSwipeBack({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const behindRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const settling = useRef<{ cancel: () => void } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  const place = (offset: number, width: number) => {
    if (ref.current) ref.current.style.transform = `translateX(${offset}px)`;
    if (behindRef.current)
      behindRef.current.style.transform = `translateX(${
        -PARALLAX_PERCENT * (1 - offset / width)
      }%)`;
  };

  // The layer behind mounts on the render after the first move, which has already placed the panel.
  useLayoutEffect(() => {
    const current = gesture.current;
    if (dragging && current) place(current.offset, current.width);
  }, [dragging]);

  useEffect(() => () => settling.current?.cancel(), []);

  const settle = (goBack: boolean, from: Gesture) => {
    const panel = ref.current;
    const reduceMotion = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let finished = false;
    const stop = () => {
      finished = true;
      settling.current = null;
      panel?.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
    const finish = () => {
      if (finished) return;
      stop();
      // A panel going back is replaced by the next render; clearing it first would flash it home.
      if (panel && !goBack) {
        panel.style.transition = '';
        panel.style.transform = '';
      }
      setDragging(false);
      if (goBack) onBackRef.current();
    };
    const onEnd = (event: TransitionEvent) => {
      if (event.target === panel && event.propertyName === 'transform') finish();
    };
    const timer = window.setTimeout(finish, SLIDE_MS + 100);
    settling.current = { cancel: stop };

    if (!panel || reduceMotion) return finish();
    panel.addEventListener('transitionend', onEnd);
    const transition = `transform ${SLIDE_MS}ms ${SLIDE_EASING}`;
    panel.style.transition = transition;
    if (behindRef.current) behindRef.current.style.transition = transition;
    place(goBack ? from.width : 0, from.width);
  };

  const point = (event: TouchEvent): Point | null => {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp } : null;
  };

  const bind = {
    onTouchStart: (event: TouchEvent) => {
      const dragged = gesture.current;
      // A second finger touching down abandons a drag in progress.
      if (event.touches.length > 1) {
        gesture.current = null;
        if (dragged?.intent === 'back') settle(false, dragged);
        return;
      }
      const start = point(event);
      const panel = ref.current;
      // A slide-in still running would override the transform this sets.
      const busy = settling.current || panel?.getAnimations?.().length;
      gesture.current =
        start && panel && !busy
          ? { start, samples: [start], intent: undefined, width: panel.offsetWidth, offset: 0 }
          : null;
    },
    onTouchMove: (event: TouchEvent) => {
      const current = gesture.current;
      const here = point(event);
      if (!current || !here || current.intent === 'scroll') return;
      if (event.touches.length > 1) {
        gesture.current = null;
        if (current.intent === 'back') settle(false, current);
        return;
      }
      current.samples = [...current.samples.slice(-7), here];
      const dx = here.x - current.start.x;
      if (!current.intent) {
        current.intent = swipeIntent(dx, here.y - current.start.y);
        if (current.intent === 'back') setDragging(true);
      }
      if (current.intent !== 'back') return;
      current.offset = Math.max(0, dx);
      place(current.offset, current.width);
    },
    onTouchEnd: (event: TouchEvent) => {
      const current = gesture.current;
      const here = point(event);
      gesture.current = null;
      if (!current || current.intent !== 'back' || !here) return;
      const dx = here.x - current.start.x;
      const velocity = releaseVelocity([...current.samples, here], here.t);
      settle(shouldGoBack({ dx, width: current.width, velocity }), current);
    },
    onTouchCancel: () => {
      const current = gesture.current;
      gesture.current = null;
      if (current?.intent === 'back') settle(false, current);
    },
  };

  return { ref, behindRef, dragging, bind: enabled ? bind : {} };
}
