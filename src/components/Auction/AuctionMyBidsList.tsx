import { Stack, Text } from '@mantine/core';
import { useCallback, useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { IconAlertCircle } from '@tabler/icons-react';
import {
  ModelMyBidCard,
  ModelMyRecurringBidCard,
  PLACEMENT_CARD_HEIGHT,
} from '~/components/Auction/AuctionPlacementCard';
import type { ChromeRow } from '~/components/Auction/VirtualRowList';
import {
  CHROME_ROW_HEIGHT,
  VirtualRowList,
  chromeRowKey,
  renderChromeRow,
  skeletonRows,
} from '~/components/Auction/VirtualRowList';
import { useIsMobile } from '~/hooks/useIsMobile';
import type { GetMyBidsReturn, GetMyRecurringBidsReturn } from '~/server/services/auction.service';

type MyBid = GetMyBidsReturn[number];
type MyRecurringBid = GetMyRecurringBidsReturn[number];
type Row = ChromeRow | { kind: 'bid'; bid: MyBid } | { kind: 'recurring'; bid: MyRecurringBid };

const SKELETON_COUNT = 3;

const errorRow: ChromeRow = {
  kind: 'message',
  node: (
    <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
      <Text>There was an error fetching your bid data. Please try again.</Text>
    </AlertWithIcon>
  ),
};

const section = ({
  label,
  isLoading,
  isError,
  empty,
  cards,
}: {
  label: string;
  isLoading: boolean;
  isError: boolean;
  empty: Row;
  cards: Row[];
}): Row[] => {
  const body: Row[] = isLoading
    ? skeletonRows(SKELETON_COUNT)
    : isError
    ? [errorRow]
    : cards.length
    ? cards
    : [empty];
  return [{ kind: 'divider' }, { kind: 'heading', label }, ...body];
};

export function AuctionMyBidsList({
  activeBids,
  recurringBids,
  pastBids,
  isLoadingBids,
  isErrorBids,
  isLoadingRecurringBids,
  isErrorRecurringBids,
  searchText,
}: {
  activeBids: MyBid[];
  recurringBids: MyRecurringBid[];
  pastBids: MyBid[];
  isLoadingBids: boolean;
  isErrorBids: boolean;
  isLoadingRecurringBids: boolean;
  isErrorRecurringBids: boolean;
  searchText: string;
}) {
  const mobile = useIsMobile({ breakpoint: 'md' });

  // All three sections share one virtualizer, so their headings, dividers and
  // empty/error/loading states are rows alongside the cards.
  const rows = useMemo<Row[]>(
    () => [
      ...section({
        label: 'Active Bids',
        isLoading: isLoadingBids,
        isError: isErrorBids,
        empty: {
          kind: 'message',
          node: (
            <Stack gap="xs" className="text-center">
              <Text>No active bids.</Text>
              <Text>Choose an auction in the list to get started.</Text>
            </Stack>
          ),
        },
        cards: activeBids.map((bid) => ({ kind: 'bid', bid })),
      }),
      ...section({
        label: 'Recurring Bids',
        isLoading: isLoadingRecurringBids,
        isError: isErrorRecurringBids,
        empty: { kind: 'message', node: <Text>No recurring bids.</Text> },
        cards: recurringBids.map((bid) => ({ kind: 'recurring', bid })),
      }),
      ...section({
        label: 'Past Bids',
        isLoading: isLoadingBids,
        isError: isErrorBids,
        empty: { kind: 'message', node: <Text>No past bids.</Text> },
        cards: pastBids.map((bid) => ({ kind: 'bid', bid })),
      }),
    ],
    [
      activeBids,
      recurringBids,
      pastBids,
      isLoadingBids,
      isErrorBids,
      isLoadingRecurringBids,
      isErrorRecurringBids,
    ]
  );

  const estimateSize = useCallback(
    (row: Row) =>
      row.kind === 'bid' || row.kind === 'recurring'
        ? mobile
          ? PLACEMENT_CARD_HEIGHT.mobile
          : PLACEMENT_CARD_HEIGHT.desktop
        : CHROME_ROW_HEIGHT[row.kind],
    [mobile]
  );

  const getKey = useCallback((row: Row, index: number) => {
    if (row.kind === 'bid') return `bid-${row.bid.auction.id}-${row.bid.entityId}`;
    if (row.kind === 'recurring') return `rec-${row.bid.auctionBase.id}-${row.bid.entityId}`;
    return chromeRowKey(row, index);
  }, []);

  const renderRow = useCallback(
    (row: Row) => {
      if (row.kind === 'bid') return <ModelMyBidCard data={row.bid} searchText={searchText} />;
      if (row.kind === 'recurring')
        return <ModelMyRecurringBidCard data={row.bid} searchText={searchText} />;
      return renderChromeRow(row);
    },
    [searchText]
  );

  return (
    <VirtualRowList rows={rows} estimateSize={estimateSize} getKey={getKey} renderRow={renderRow} />
  );
}
