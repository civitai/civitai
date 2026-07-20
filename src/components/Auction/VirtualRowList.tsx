import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

export const VIRTUAL_ROW_GAP = 8;

/**
 * Windows a list of already-built rows against the app scroll area. Auction lists run to
 * hundreds of cards (an auction allows up to 1000) and each card is expensive — an image,
 * an ImageGuard, an avatar with cosmetics — so mounting them all is what makes switching
 * auctions slow even with everything served from cache.
 *
 * Heterogeneous rows (cards, section headers, dividers) go in one list rather than one
 * virtualizer per section: nested virtualizers would each need their own scroll offset
 * accounting against the same scroll parent.
 */
export function VirtualRowList<T>({
  rows,
  estimateSize,
  getKey,
  renderRow,
}: {
  rows: T[];
  /** Only seeds the scrollbar — `measureElement` corrects each row once mounted. */
  estimateSize: (row: T) => number;
  getKey: (row: T, index: number) => string | number;
  renderRow: (row: T) => ReactNode;
}) {
  const scrollAreaRef = useScrollAreaRef();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);

  // Distance from the top of the scroll container down to this list. Recomputed when the
  // row count changes; content above the list that resizes without changing the count
  // (e.g. an expanding filter panel) will not trigger it.
  useLayoutEffect(() => {
    if (!listRef.current || !scrollAreaRef?.current) return;
    let offset = 0;
    let current: HTMLElement | null = listRef.current;
    while (current && current !== scrollAreaRef.current) {
      offset += current.offsetTop;
      current = current.offsetParent as HTMLElement;
    }
    setScrollMargin(offset);
  }, [scrollAreaRef, rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: useCallback(
      (index: number) => {
        const row = rows[index];
        return row ? estimateSize(row) + VIRTUAL_ROW_GAP : VIRTUAL_ROW_GAP;
      },
      [rows, estimateSize]
    ),
    getItemKey: useCallback(
      (index: number) => {
        const row = rows[index];
        return row ? getKey(row, index) : index;
      },
      [rows, getKey]
    ),
    overscan: 5,
    scrollMargin,
    // See MasonryGridVirtual for rationale — opts out of virtual-core's 150ms
    // setTimeout debounce on every scroll tick.
    useScrollendEvent: true,
  });

  return (
    <div
      ref={listRef}
      style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}
    >
      {virtualizer.getVirtualItems().map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) return null;

        return (
          <div
            key={String(virtualItem.key)}
            data-index={virtualItem.index}
            ref={virtualizer.measureElement}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              paddingBottom: VIRTUAL_ROW_GAP,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );
}
