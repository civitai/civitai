import type { RefObject } from 'react';
import { useEffect, useState } from 'react';

type Options = {
  /** How far to scroll, since the last change of direction, before the header hides or returns. */
  distance?: number;
  /** Above this scroll offset the header always shows. */
  topZone?: number;
  /** The header shows again whenever this changes. */
  resetKey?: unknown;
  enabled?: boolean;
};

/**
 * True while the content scrolls down, false once it scrolls back up or reaches the top: the one
 * rule for headers that get out of the way of a scrolling list. How the header hides (slides,
 * folds) is the caller's.
 *
 * `target` is the window, or an element that is or contains the scrolling element; an element is
 * listened to in the capture phase, so the scroller can sit anywhere inside it. Scrolls of elements
 * that can't scroll vertically (a row of chips) are ignored. With no target, nothing hides.
 */
export function useHideOnScroll(
  target: RefObject<HTMLElement> | 'window' | undefined,
  { distance = 100, topZone = 100, resetKey, enabled = true }: Options = {}
) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    setHidden(false);
    if (!enabled) return;
    const source = target === 'window' ? window : target?.current;
    if (!source) return;

    let lastY = 0;
    let goingDown = false;
    let turnedAt = 0;
    const onScroll = (e: Event) => {
      let y: number;
      if (target === 'window') y = window.scrollY;
      else {
        const el = e.target as HTMLElement;
        if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight) return;
        y = el.scrollTop;
      }
      const down = y > lastY;
      if (down !== goingDown) {
        goingDown = down;
        turnedAt = lastY;
      }
      lastY = y;
      if (y < topZone) setHidden(false);
      else if (y - turnedAt > distance) setHidden(true);
      else if (y - turnedAt < -distance) setHidden(false);
    };

    const options = { capture: target !== 'window', passive: true };
    source.addEventListener('scroll', onScroll, options);
    return () => source.removeEventListener('scroll', onScroll, options);
  }, [target, distance, topZone, resetKey, enabled]);

  return enabled && hidden;
}
