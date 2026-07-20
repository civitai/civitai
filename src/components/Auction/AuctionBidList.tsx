import { Text } from '@mantine/core';
import { useCallback, useMemo } from 'react';
import {
  ModelPlacementCard,
  PLACEMENT_CARD_HEIGHT,
} from '~/components/Auction/AuctionPlacementCard';
import type { ChromeRow } from '~/components/Auction/VirtualRowList';
import {
  CHROME_ROW_HEIGHT,
  VirtualRowList,
  chromeRowKey,
  renderChromeRow,
} from '~/components/Auction/VirtualRowList';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { GetAuctionBySlugReturn } from '~/server/services/auction.service';
import type { GenerationResource } from '~/shared/types/generation.types';

type Bid = GetAuctionBySlugReturn['bids'][number];
type Row = ChromeRow | { kind: 'bid'; bid: Bid; aboveThreshold: boolean };

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
      ? bidsAbove.map((bid) => ({ kind: 'bid', bid, aboveThreshold: true }))
      : [{ kind: 'message', node: <Text>No bids meeting minimum threshold.</Text> }];
    const below: Row[] = bidsBelow.length
      ? [
          { kind: 'divider' },
          ...bidsBelow.map((bid): Row => ({ kind: 'bid', bid, aboveThreshold: false })),
        ]
      : [];
    return [...above, ...below];
  }, [bidsAbove, bidsBelow]);

  const estimateSize = useCallback(
    (row: Row) =>
      row.kind === 'bid'
        ? mobile
          ? PLACEMENT_CARD_HEIGHT.mobile
          : PLACEMENT_CARD_HEIGHT.desktop
        : CHROME_ROW_HEIGHT[row.kind],
    [mobile]
  );

  const getKey = useCallback(
    (row: Row, index: number) => (row.kind === 'bid' ? row.bid.entityId : chromeRowKey(row, index)),
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
      ) : (
        renderChromeRow(row)
      ),
    [addBidFn, searchText, canBid]
  );

  return (
    <VirtualRowList rows={rows} estimateSize={estimateSize} getKey={getKey} renderRow={renderRow} />
  );
}
