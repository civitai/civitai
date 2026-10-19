import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useScrollMargin } from '~/hooks/useScrollMargin';
import type { CommentGetAllItem } from '~/types/router';

const MIN_COLUMN_WIDTH = 300;
const GAP = 16;
const ESTIMATED_HEIGHT = 200;

export function CommentMasonryVirtual({
  comments,
  modelUserId,
  overscan = 4,
}: {
  comments: CommentGetAllItem[];
  modelUserId?: number;
  overscan?: number;
}) {
  const [width, setWidth] = useState(0);
  const ref = useResizeObserver<HTMLDivElement>((entry) => setWidth(entry.contentRect.width));
  useIsomorphicLayoutEffect(() => {
    if (ref.current) setWidth(ref.current.clientWidth);
  }, [ref]);

  const columnCount = Math.max(1, Math.floor((width + GAP) / (MIN_COLUMN_WIDTH + GAP)));
  const columnWidth = (width - GAP * (columnCount - 1)) / columnCount;

  // The margin is shared: every column starts at the same y as this row.
  const scrollMargin = useScrollMargin(ref);

  const heights = useRef(new Map<number, number>());
  const lanes = useRef({ columnCount, byId: new Map<number, number>() });

  // Columns are assigned once per comment. TanStack's own `lanes` option re-picks the shortest
  // lane for every item on every measurement pass, so cards swap columns as heights settle.
  const columns = useMemo(() => {
    if (width === 0) return [];
    if (lanes.current.columnCount !== columnCount) {
      lanes.current = { columnCount, byId: new Map() };
      heights.current.clear();
    }
    const { byId } = lanes.current;
    const columnHeights = Array<number>(columnCount).fill(0);
    const result: CommentGetAllItem[][] = Array.from({ length: columnCount }, () => []);

    for (const comment of comments) {
      let lane = byId.get(comment.id);
      if (lane === undefined) {
        lane = columnHeights.indexOf(Math.min(...columnHeights));
        byId.set(comment.id, lane);
      }
      columnHeights[lane] += (heights.current.get(comment.id) ?? ESTIMATED_HEIGHT) + GAP;
      result[lane].push(comment);
    }
    return result;
  }, [comments, columnCount, width]);

  return (
    <div ref={ref} style={{ display: 'flex', gap: GAP, width: '100%', alignItems: 'flex-start' }}>
      {columns.map((items, lane) => (
        <VirtualColumn
          key={lane}
          items={items}
          modelUserId={modelUserId}
          columnWidth={columnWidth}
          scrollMargin={scrollMargin}
          overscan={overscan}
          onMeasure={(id, height) => heights.current.set(id, height)}
        />
      ))}
    </div>
  );
}

function VirtualColumn({
  items,
  modelUserId,
  columnWidth,
  scrollMargin,
  overscan,
  onMeasure,
}: {
  items: CommentGetAllItem[];
  modelUserId?: number;
  columnWidth: number;
  scrollMargin: number;
  overscan: number;
  onMeasure: (id: number, height: number) => void;
}) {
  const scrollAreaRef = useScrollAreaRef();

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: () => ESTIMATED_HEIGHT,
    overscan,
    gap: GAP,
    scrollMargin,
    getItemKey: (index) => items[index].id,
    initialOffset: () => scrollAreaRef?.current?.scrollTop ?? 0,
    measureElement: (el) => {
      const height = el.getBoundingClientRect().height;
      onMeasure(Number((el as HTMLElement).dataset.id), height);
      return height;
    },
    useScrollendEvent: true,
  });

  // Cached heights belong to the previous column width.
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, columnWidth]);

  return (
    <div style={{ position: 'relative', width: columnWidth, height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const comment = items[virtualItem.index];
        return (
          <div
            key={comment.id}
            ref={virtualizer.measureElement}
            data-index={virtualItem.index}
            data-id={comment.id}
            style={{
              position: 'absolute',
              top: virtualItem.start - virtualizer.options.scrollMargin,
              left: 0,
              width: '100%',
            }}
          >
            <CommentDiscussionItem data={comment} modelUserId={modelUserId} />
          </div>
        );
      })}
    </div>
  );
}
