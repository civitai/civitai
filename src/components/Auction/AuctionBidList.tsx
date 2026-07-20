import { Center, Divider, Text } from '@mantine/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ModelPlacementCard } from '~/components/Auction/AuctionPlacementCard';
import { useScrollAreaRef } from '~/components/ScrollArea/ScrollAreaContext';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { GenerationResource } from '~/shared/types/generation.types';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';

type Bid = GetAuctionBySlugReturn['bids'][number];

type Row =
  | { kind: 'bid'; bid: Bid; aboveThreshold: boolean }
  | { kind: 'divider' }
  | { kind: 'empty' };

// The card is a fixed-height row on desktop and stacks on mobile. These only need to be
// close enough to seed the scrollbar — `measureElement` corrects each row once mounted.
const ESTIMATED_ROW_HEIGHT = { desktop: 116, mobile: 232 };
const DIVIDER_HEIGHT = 33;
const ROW_GAP = 8;

export function AuctionBidList({
  bidsAbove,
  bidsBelow,
  addBidFn,
  searchText,
  canBid,
}: {
  bidsAbove: Bid[];
  bidsBelow: Bid[];
  addBidFn: (r: GenerationResource) => void;
  searchText: string;
  canBid: boolean;
}) {
  const scrollAreaRef = useScrollAreaRef();
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const mobile = useIsMobile({ breakpoint: 'md' });

  // One flat row list so a single virtualizer spans both sections and the divider
  // between them; two virtualizers would each need their own scroll accounting.
  const rows = useMemo<Row[]>(() => {
    const above: Row[] = bidsAbove.length
      ? bidsAbove.map((bid) => ({ kind: 'bid' as const, bid, aboveThreshold: true }))
      : [{ kind: 'empty' as const }];
    const below: Row[] = bidsBelow.length
      ? [
          { kind: 'divider' as const },
          ...bidsBelow.map((bid) => ({ kind: 'bid' as const, bid, aboveThreshold: false })),
        ]
      : [];
    return [...above, ...below];
  }, [bidsAbove, bidsBelow]);

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
      (index: number) =>
        (rows[index]?.kind === 'divider'
          ? DIVIDER_HEIGHT
          : mobile
          ? ESTIMATED_ROW_HEIGHT.mobile
          : ESTIMATED_ROW_HEIGHT.desktop) + ROW_GAP,
      [rows, mobile]
    ),
    getItemKey: useCallback(
      (index: number) => {
        const row = rows[index];
        return row?.kind === 'bid' ? row.bid.entityId : `${row?.kind}-${index}`;
      },
      [rows]
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
              paddingBottom: ROW_GAP,
              transform: `translateY(${virtualItem.start - scrollMargin}px)`,
            }}
          >
            {row.kind === 'bid' ? (
              <ModelPlacementCard
                data={row.bid}
                aboveThreshold={row.aboveThreshold}
                addBidFn={addBidFn}
                searchText={searchText}
                canBid={canBid}
              />
            ) : row.kind === 'divider' ? (
              <Divider label="Below Threshold" labelPosition="center" />
            ) : (
              <Center>
                <Text>No bids meeting minimum threshold.</Text>
              </Center>
            )}
          </div>
        );
      })}
    </div>
  );
}
