import type { PointerEvent } from 'react';
import { useRef, useState } from 'react';

// A downward drag of a sheet's top this far closes it.
const SWIPE_CLOSE_PX = 100;

/**
 * A bottom sheet's drag-down-to-close, on the element given `handlers` (its grab area): `offset`
 * follows the pointer down for the sheet to translate by, and a release past `SWIPE_CLOSE_PX`
 * calls `onClose`. A press that starts on a button is the button's.
 */
export function useSwipeToClose(onClose: () => void) {
  const [offset, setOffset] = useState(0);
  const drag = useRef<{ pointerId: number; startY: number } | null>(null);

  const reset = () => {
    drag.current = null;
    setOffset(0);
  };

  const handlers = {
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if ((e.target as Element).closest('button')) return;
      drag.current = { pointerId: e.pointerId, startY: e.clientY };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId !== e.pointerId) return;
      setOffset(Math.max(0, e.clientY - drag.current.startY));
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId !== e.pointerId) return;
      const dy = e.clientY - drag.current.startY;
      reset();
      if (dy >= SWIPE_CLOSE_PX) onClose();
    },
    onPointerCancel: reset,
  };

  return { offset, handlers };
}
