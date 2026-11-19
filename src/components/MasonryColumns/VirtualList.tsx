import { useVirtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useScrollMargin } from '~/hooks/useScrollMargin';

/**
 * A single column of fixed-height rows, virtualized against the page's scroll area the way
 * `MasonryColumnsVirtual` is.
 */
export function VirtualList<TData>({
  data,
  itemHeight,
  itemId,
  render: Item,
  overscan = 10,
}: {
  data: TData[];
  itemHeight: number;
  itemId: (data: TData) => string | number;
  render: React.ComponentType<{ data: TData; index: number }>;
  overscan?: number;
}) {
  const scrollAreaRef = useScrollAreaRef();
  const ref = useRef<HTMLDivElement>(null);
  const scrollMargin = useScrollMargin(ref);
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: () => itemHeight,
    getItemKey: (index) => itemId(data[index]),
    overscan,
    scrollMargin,
    initialOffset: () => scrollAreaRef?.current?.scrollTop ?? 0,
    useScrollendEvent: true,
  });

  return (
    <div ref={ref} role="list" className="relative" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((row) => (
        <div
          key={String(row.key)}
          role="listitem"
          className="absolute inset-x-0 top-0"
          style={{
            height: itemHeight,
            transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)`,
          }}
        >
          <Item data={data[row.index]} index={row.index} />
        </div>
      ))}
    </div>
  );
}
