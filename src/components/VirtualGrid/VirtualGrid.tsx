import { useVirtualizer } from '@tanstack/react-virtual';
import type { ComponentType, RefObject } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';

type Props<T> = {
  items: T[];
  render: ComponentType<{ data: T; width: number }>;
  getKey: (item: T) => string | number;
  /** Minimum cell width; columns stretch to fill the row. */
  columnWidth: number;
  maxColumnCount?: number;
  gap?: number;
  /** Only seeds the scrollbar; each row is measured once mounted. */
  estimateRowHeight: number;
  maxHeight: number;
  overscan?: number;
};

/** A grid of equal-width cells in its own scroll box, mounting only the visible rows. */
export function VirtualGrid<T>({
  items,
  render: Item,
  getKey,
  columnWidth,
  maxColumnCount = Infinity,
  gap = 0,
  estimateRowHeight,
  maxHeight,
  overscan = 4,
}: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useInnerWidth(ref);
  const columnCount = Math.max(
    1,
    Math.min(maxColumnCount, Math.floor((width + gap) / (columnWidth + gap)))
  );
  const cellWidth = width
    ? Math.floor((width - gap * (columnCount - 1)) / columnCount)
    : columnWidth;

  const virtualizer = useVirtualizer({
    // Until the box is measured every item would be its own row.
    count: width ? Math.ceil(items.length / columnCount) : 0,
    getScrollElement: () => ref.current,
    estimateSize: () => estimateRowHeight,
    overscan,
    gap,
  });

  // Row heights are cached by index, and a new column count puts different cells in each row.
  useEffect(() => virtualizer.measure(), [virtualizer, columnCount]);

  return (
    <div ref={ref} style={{ maxHeight, overflowY: 'auto', scrollbarGutter: 'stable' }}>
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
        {virtualizer.getVirtualItems().map((row) => (
          <div
            key={String(row.key)}
            data-index={row.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              display: 'flex',
              gap,
              transform: `translateY(${row.start}px)`,
            }}
          >
            {items.slice(row.index * columnCount, (row.index + 1) * columnCount).map((item) => (
              <Item key={getKey(item)} data={item} width={cellWidth} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Width rows can use, excluding the scrollbar. Mantine's useElementSize reports the border
 * box, so cells sized from it overflow by the scrollbar's width.
 */
function useInnerWidth(ref: RefObject<HTMLDivElement>) {
  const [width, setWidth] = useState(0);
  useIsomorphicLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
