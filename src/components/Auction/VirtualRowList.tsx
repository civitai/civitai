import { Center, Divider, Stack, Title } from '@mantine/core';
import { Skeleton } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ReactNode } from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';

const ROW_GAP = 8;
const SKELETON_HEIGHT = 78;

/** Section furniture every auction list needs around its cards. */
export type ChromeRow =
  | { kind: 'divider' }
  | { kind: 'heading'; label: string }
  | { kind: 'message'; node: ReactNode }
  | { kind: 'skeleton' };

export const CHROME_ROW_HEIGHT: Record<ChromeRow['kind'], number> = {
  divider: 33,
  heading: 30,
  message: 60,
  skeleton: SKELETON_HEIGHT,
};

export const renderChromeRow = (row: ChromeRow) => {
  switch (row.kind) {
    case 'divider':
      return <Divider my="sm" />;
    case 'heading':
      return <Title order={5}>{row.label}</Title>;
    case 'message':
      return <Center my="lg">{row.node}</Center>;
    case 'skeleton':
      return <Skeleton height={SKELETON_HEIGHT} radius="sm" animate />;
  }
};

export const skeletonRows = (count: number): ChromeRow[] =>
  Array.from({ length: count }, () => ({ kind: 'skeleton' }));

/**
 * Windows a list of already-built rows against the app scroll area. Auction lists run to
 * hundreds of cards (an auction allows up to 1000) and each card is expensive — an image,
 * an ImageGuard, an avatar with cosmetics — so mounting them all is what makes switching
 * auctions slow even with everything served from cache.
 *
 * Heterogeneous rows (cards, section headings, dividers) go in one list rather than one
 * virtualizer per section: nested virtualizers would each need their own scroll offset
 * accounting against the same scroll parent.
 */
export function VirtualRowList<T extends { kind: string }>({
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

  // Rows are positioned relative to the scroll container, so the distance down to this
  // list has to track anything above it resizing — the search box and the collapsible
  // filter panel both do, without changing the row count.
  useLayoutEffect(() => {
    const list = listRef.current;
    const scrollArea = scrollAreaRef?.current;
    if (!list || !scrollArea) return;

    const measure = () => {
      let offset = 0;
      let current: HTMLElement | null = list;
      while (current && current !== scrollArea) {
        offset += current.offsetTop;
        current = current.offsetParent as HTMLElement;
      }
      setScrollMargin(offset);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scrollArea);
    return () => observer.disconnect();
  }, [scrollAreaRef, rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollAreaRef?.current ?? null,
    estimateSize: useCallback(
      (index: number) => {
        const row = rows[index];
        return row ? estimateSize(row) : 0;
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
    gap: ROW_GAP,
    scrollMargin,
    // Native scrollend; virtual-core's fallback installs a 150ms timer per scroll tick.
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

/** Convenience for lists whose only non-card rows are chrome. */
export const chromeRowKey = (row: ChromeRow, index: number) => `${row.kind}-${index}`;

export const StackedSkeletons = ({ count }: { count: number }) => (
  <Stack>
    {Array.from({ length: count }, (_, i) => (
      <Skeleton key={i} height={SKELETON_HEIGHT} radius="sm" animate />
    ))}
  </Stack>
);
