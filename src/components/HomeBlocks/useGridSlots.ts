import { useLayoutEffect, useRef, useState } from 'react';

/**
 * How many items the home block grid shows, or `undefined` when it scrolls instead.
 *
 * The grid clips what overflows its columns, so a full row would push a trailing tile out of
 * sight. Narrow widths scroll (overflow-x is `auto` there) and reach every item.
 */
export function useGridSlots(rows: number, enabled: boolean, ready = true) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [slots, setSlots] = useState<number>();

  useLayoutEffect(() => {
    const el = gridRef.current;
    if (!el || !enabled) return;
    const measure = () => {
      const style = getComputedStyle(el);
      // The computed value also lists the implicit tracks that clipped items and the ::after
      // spacer create, so count only the leading run of tracks as wide as the first.
      const tracks = style.gridTemplateColumns.split(' ').filter(Boolean);
      const columns = tracks.findIndex((track) => track !== tracks[0]);
      setSlots(
        style.overflowX === 'auto' ? undefined : (columns === -1 ? tracks.length : columns) * rows
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, rows, ready]);

  return { gridRef, slots };
}
