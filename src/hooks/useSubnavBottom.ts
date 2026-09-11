import { useCallback, useEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

/** Breathing room between the subnav's bottom edge and whatever pins itself beneath it. */
export const SUBNAV_STICKY_GAP = 16;

/**
 * Where the subnav's bottom edge currently sits, for anything that sticks beneath it.
 *
 * The subnav is `sticky top-0` inside the scroll area and hides by translating itself off screen,
 * so it keeps its layout box either way. A fixed sticky offset therefore leaves a gap the height of
 * the subnav once it retracts. Track where its bottom edge actually is instead.
 *
 * 🔴 Scrolling is not the only thing that moves it. The subnav slides on a CSS
 * `transition-transform`, and the scroll that triggered the slide ends before the slide does — so a
 * scroll-only measurement freezes at wherever the bar was mid-animation. On the way back in that
 * leaves the follower pinned at the retracted offset while the subnav (`z-50`) finishes sliding
 * over the top of it, and nothing corrects it until the next scroll. Re-measuring on `transitionend`
 * is what closes that window.
 */
export function useSubnavBottom() {
  const [bottom, setBottom] = useState(0);
  const frame = useRef<number>();

  const measure = useCallback((node: HTMLElement) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const subnav = node.querySelector<HTMLElement>('[data-subnav]');
      if (!subnav) return setBottom(0);
      const offset = subnav.getBoundingClientRect().bottom - node.getBoundingClientRect().top;
      setBottom(Math.max(0, Math.round(offset)));
    });
  }, []);

  const ref = useScrollAreaRef({ onScroll: measure });

  useEffect(() => {
    const node = ref?.current;
    if (!node) return;
    measure(node);

    // Bubbles from the subnav, which is a descendant of the scroll area. Filtered to `transform`
    // so an unrelated colour or opacity transition inside the bar cannot drive a re-measure.
    const onTransitionEnd = (event: TransitionEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.propertyName !== 'transform' || !target?.hasAttribute?.('data-subnav')) return;
      measure(node);
    };

    node.addEventListener('transitionend', onTransitionEnd);
    return () => {
      node.removeEventListener('transitionend', onTransitionEnd);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [ref, measure]);

  return bottom;
}
