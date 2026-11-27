import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState } from 'react';
import { assignLanes } from '~/components/Model/ModelDiscussion/comment-lanes';
import type { Lanes } from '~/components/Model/ModelDiscussion/comment-lanes';
import { CommentDiscussionItem } from '~/components/Model/ModelDiscussion/CommentDiscussionItem';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsomorphicLayoutEffect } from '~/hooks/useIsomorphicLayoutEffect';
import { useResizeObserver } from '~/hooks/useResizeObserver';
import { useScrollMargin } from '~/hooks/useScrollMargin';
import type { CommentV3Comment } from '~/components/CommentsV3/types';

const MIN_COLUMN_WIDTH = 300;
const GAP = 16;
const ESTIMATED_HEIGHT = 200;

export function CommentMasonryVirtual({
  comments,
  modelUserId,
  overscan = 4,
  renderItem = (comment) => <CommentDiscussionItem data={comment} modelUserId={modelUserId} />,
}: {
  comments: CommentV3Comment[];
  modelUserId?: number;
  overscan?: number;
  renderItem?: (comment: CommentV3Comment) => ReactNode;
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
  const lanes = useRef<Lanes>({ columnCount, byId: new Map() });

  const columns = useMemo(() => {
    if (width === 0) return [];
    if (lanes.current.columnCount !== columnCount) heights.current.clear();
    const result = assignLanes({
      ids: comments.map((c) => c.id),
      columnCount,
      previous: lanes.current,
      heights: heights.current,
      estimate: ESTIMATED_HEIGHT,
      gap: GAP,
    });
    lanes.current = result.lanes;
    const byId = new Map(comments.map((c) => [c.id, c]));
    return result.columns.map((ids) => ids.map((id) => byId.get(id)!));
  }, [comments, columnCount, width]);

  return (
    <div ref={ref} style={{ display: 'flex', gap: GAP, width: '100%', alignItems: 'flex-start' }}>
      {columns.map((items, lane) => (
        <VirtualColumn
          key={lane}
          items={items}
          renderItem={renderItem}
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
  renderItem,
  columnWidth,
  scrollMargin,
  overscan,
  onMeasure,
}: {
  items: CommentV3Comment[];
  renderItem: (comment: CommentV3Comment) => ReactNode;
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

  const columnRef = useRef<HTMLDivElement>(null);

  // measure() empties the size cache, and a card whose height did not change at the new width
  // fires no resize, so it would stay at the estimate. measureElement only records a size that
  // differs from the measurements, so getTotalSize() rebuilds those at the estimate first. The
  // estimate was never painted, so the sizes recorded against it must not move the scroll.
  useIsomorphicLayoutEffect(() => {
    const adjust = virtualizer.shouldAdjustScrollPositionOnItemSizeChange;
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false;
    virtualizer.measure();
    virtualizer.getTotalSize();
    columnRef.current
      ?.querySelectorAll<HTMLElement>('[data-index]')
      .forEach((el) => virtualizer.measureElement(el));
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = adjust;
  }, [virtualizer, columnWidth]);

  return (
    <div
      ref={columnRef}
      style={{ position: 'relative', width: columnWidth, height: virtualizer.getTotalSize() }}
    >
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
            {renderItem(comment)}
          </div>
        );
      })}
    </div>
  );
}
