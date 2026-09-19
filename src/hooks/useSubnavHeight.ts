import { useEffect, useState } from 'react';

/**
 * How tall the sticky sub-nav is, for anything rendered BESIDE it that has to line up
 * — AppLayout's `left` column sits outside the scroll area, so `useSubnavBottom`
 * (which measures within it) reads nothing there.
 *
 * Measured rather than assumed because the bar's height is not a constant: the
 * verify-email and rewards banners render inside it, so it is taller for some people
 * than others. Retracting on scroll is a `transform`, which does not change height,
 * so this settles once and stays put.
 */
export function useSubnavHeight() {
  const [height, setHeight] = useState<number>();

  useEffect(() => {
    const subnav = document.querySelector<HTMLElement>('[data-subnav]');
    if (!subnav) return;

    const observer = new ResizeObserver(([entry]) =>
      setHeight(Math.round(entry.contentRect.height))
    );
    observer.observe(subnav);
    return () => observer.disconnect();
  }, []);

  return height;
}
