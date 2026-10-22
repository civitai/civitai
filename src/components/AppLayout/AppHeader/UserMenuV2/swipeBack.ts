import { useRef } from 'react';
import type { TouchEvent } from 'react';

const MIN_DISTANCE_PX = 64;
const MAX_DURATION_MS = 700;

type Point = { x: number; y: number; t: number };

/** A flick to the right that is mostly horizontal: not a vertical scroll, and not a held drag. */
export function isSwipeBack(start: Point, end: Point) {
  const dx = end.x - start.x;
  const dy = Math.abs(end.y - start.y);
  return dx >= MIN_DISTANCE_PX && dy * 2 <= dx && end.t - start.t <= MAX_DURATION_MS;
}

/** Touch handlers that call `onBack` on a right swipe; spread them on the panel. */
export function useSwipeBack(onBack: () => void, enabled: boolean) {
  const start = useRef<Point | null>(null);
  if (!enabled) return {};

  const point = (event: TouchEvent): Point | null => {
    const touch = event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY, t: event.timeStamp } : null;
  };

  return {
    onTouchStart: (event: TouchEvent) => {
      start.current = event.touches.length === 1 ? point(event) : null;
    },
    onTouchEnd: (event: TouchEvent) => {
      const from = start.current;
      const to = point(event);
      start.current = null;
      if (from && to && isSwipeBack(from, to)) onBack();
    },
    onTouchCancel: () => {
      start.current = null;
    },
  };
}
