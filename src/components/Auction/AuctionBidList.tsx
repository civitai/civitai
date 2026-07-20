import { Center, Divider, Text } from '@mantine/core';
import { useCallback, useMemo } from 'react';
import { ModelPlacementCard } from '~/components/Auction/AuctionPlacementCard';
import { VirtualRowList } from '~/components/Auction/VirtualRowList';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { GenerationResource } from '~/shared/types/generation.types';

type Bid = GetAuctionBySlugReturn['bids'][number];

type Row =
  | { kind: 'bid'; bid: Bid; aboveThreshold: boolean }
  | { kind: 'divider' }
  | { kind: 'empty' };

// The card is a fixed-height row on desktop and stacks on mobile.
const CARD_HEIGHT = { desktop: 116, mobile: 232 };
const SMALL_ROW_HEIGHT = 33;

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
  const mobile = useIsMobile({ breakpoint: 'md' });

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

  const estimateSize = useCallback(
    (row: Row) =>
      row.kind === 'bid' ? (mobile ? CARD_HEIGHT.mobile : CARD_HEIGHT.desktop) : SMALL_ROW_HEIGHT,
    [mobile]
  );

  const getKey = useCallback(
    (row: Row, index: number) => (row.kind === 'bid' ? row.bid.entityId : `${row.kind}-${index}`),
    []
  );

  const renderRow = useCallback(
    (row: Row) =>
      row.kind === 'bid' ? (
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
      ),
    [addBidFn, searchText, canBid]
  );

  return (
    <VirtualRowList rows={rows} estimateSize={estimateSize} getKey={getKey} renderRow={renderRow} />
  );
}
