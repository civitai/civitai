import { Center, Divider, Skeleton, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertCircle, IconSearch, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import React, { useCallback, useMemo, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AuctionTopSection } from '~/components/Auction/AuctionInfo';
import { ModelMyBidCard, ModelMyRecurringBidCard } from '~/components/Auction/AuctionPlacementCard';
import { VirtualRowList } from '~/components/Auction/VirtualRowList';
import { useIsMobile } from '~/hooks/useIsMobile';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GetMyBidsReturn, GetMyRecurringBidsReturn } from '~/server/services/auction.service';
import { AuctionType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

const bidSkeletons = (
  <Stack>
    {Array.from({ length: 3 }, (_, i) => (
      <Skeleton key={i} height={78} radius="sm" animate />
    ))}
  </Stack>
);

const BidDataError = () => (
  <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
    <Text>There was an error fetching your bid data. Please try again.</Text>
  </AlertWithIcon>
);

type Row =
  | { kind: 'bid'; bid: GetMyBidsReturn[number] }
  | { kind: 'recurring'; bid: GetMyRecurringBidsReturn[number] }
  | { kind: 'heading'; label: string }
  | { kind: 'divider' }
  | { kind: 'skeletons' }
  | { kind: 'message'; node: ReactNode };

// The cards are fixed-height rows on desktop and stack on mobile.
const CARD_HEIGHT = { desktop: 116, mobile: 232 };

export const AuctionMyBids = () => {
  const currentUser = useCurrentUser();
  const mobile = useIsMobile({ breakpoint: 'md' });
  const [searchText, setSearchText] = useState<string>('');
  const searchLower = searchText.toLowerCase();

  const {
    data: bidData = [],
    // isLoading: isLoadingBidData,
    isInitialLoading: isInitialLoadingBidData,
    isRefetching: isRefetchingBidData,
    isError: isErrorBidData,
  } = trpc.auction.getMyBids.useQuery(undefined, { enabled: !!currentUser });

  const {
    data: bidRecurringData = [],
    // isLoading: isLoadingBidRecurringData,
    isInitialLoading: isInitialLoadingBidRecurringData,
    isRefetching: isRefetchingBidRecurringData,
    isError: isErrorBidRecurringData,
  } = trpc.auction.getMyRecurringBids.useQuery(undefined, { enabled: !!currentUser });

  const isLoadingBidData = isInitialLoadingBidData || isRefetchingBidData;
  const isLoadingBidRecurringData =
    isInitialLoadingBidRecurringData || isRefetchingBidRecurringData;

  const hasSearchText = useCallback(
    (
      base: GetMyRecurringBidsReturn[number]['auctionBase'],
      d: GetMyBidsReturn[number]['entityData']
    ) => {
      if (!searchLower || !searchLower.length) return true;
      if (base.type === AuctionType.Model) {
        return (
          (d?.name?.toLowerCase() ?? '').includes(searchLower) ||
          (d?.model?.name?.toLowerCase() ?? '').includes(searchLower)
        );
      }
      return true;
    },
    [searchLower]
  );

  const activeBids = useMemo(
    () =>
      bidData
        .filter((bd) => bd.isActive && hasSearchText(bd.auction.auctionBase, bd.entityData))
        .filter(isDefined),
    [bidData, hasSearchText]
  );
  const pastBids = useMemo(
    () =>
      bidData.filter((bd) => !bd.isActive && hasSearchText(bd.auction.auctionBase, bd.entityData)),
    [bidData, hasSearchText]
  );
  const recurringBids = useMemo(
    () => bidRecurringData.filter((bd) => hasSearchText(bd.auctionBase, bd.entityData)),
    [bidRecurringData, hasSearchText]
  );

  // All three sections share one virtualizer, so their headings, dividers and
  // empty/error/loading states become rows alongside the cards.
  const rows = useMemo<Row[]>(() => {
    const section = (
      label: string,
      isLoading: boolean,
      isError: boolean,
      empty: ReactNode,
      cards: Row[]
    ): Row[] => [
      { kind: 'divider' },
      { kind: 'heading', label },
      ...(isLoading
        ? ([{ kind: 'skeletons' }] as Row[])
        : isError
        ? ([{ kind: 'message', node: <BidDataError /> }] as Row[])
        : !cards.length
        ? ([{ kind: 'message', node: empty }] as Row[])
        : cards),
    ];

    return [
      ...section(
        'Active Bids',
        isLoadingBidData,
        isErrorBidData,
        <Stack gap="xs" className="text-center">
          <Text>No active bids.</Text>
          <Text>Choose an auction in the list to get started.</Text>
        </Stack>,
        activeBids.map((bid) => ({ kind: 'bid' as const, bid }))
      ),
      ...section(
        'Recurring Bids',
        isLoadingBidRecurringData,
        isErrorBidRecurringData,
        <Text>No recurring bids.</Text>,
        recurringBids.map((bid) => ({ kind: 'recurring' as const, bid }))
      ),
      ...section(
        'Past Bids',
        isLoadingBidData,
        isErrorBidData,
        <Text>No past bids.</Text>,
        pastBids.map((bid) => ({ kind: 'bid' as const, bid }))
      ),
    ];
  }, [
    activeBids,
    recurringBids,
    pastBids,
    isLoadingBidData,
    isErrorBidData,
    isLoadingBidRecurringData,
    isErrorBidRecurringData,
  ]);

  const estimateSize = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case 'bid':
        case 'recurring':
          return mobile ? CARD_HEIGHT.mobile : CARD_HEIGHT.desktop;
        case 'skeletons':
          return 3 * 78;
        case 'message':
          return 60;
        default:
          return 33;
      }
    },
    [mobile]
  );

  const getKey = useCallback((row: Row, index: number) => {
    if (row.kind === 'bid') return `bid-${row.bid.auction.id}-${row.bid.entityId}`;
    if (row.kind === 'recurring') return `rec-${row.bid.auctionBase.id}-${row.bid.entityId}`;
    return `${row.kind}-${index}`;
  }, []);

  const renderRow = useCallback(
    (row: Row) => {
      switch (row.kind) {
        case 'bid':
          return <ModelMyBidCard data={row.bid} searchText={searchText} />;
        case 'recurring':
          return <ModelMyRecurringBidCard data={row.bid} searchText={searchText} />;
        case 'heading':
          return <Title order={5}>{row.label}</Title>;
        case 'divider':
          return <Divider my="sm" />;
        case 'skeletons':
          return bidSkeletons;
        case 'message':
          return <Center my="lg">{row.node}</Center>;
      }
    },
    [searchText]
  );

  return (
    <Stack w="100%" gap="sm">
      <AuctionTopSection showHistory={false} />

      <Title order={3}>My Bids</Title>
      <TextInput
        leftSection={<IconSearch size={16} />}
        placeholder="Filter items..."
        value={searchText}
        maxLength={150}
        disabled={!bidData.length && !bidRecurringData.length}
        onChange={(event) => setSearchText(event.currentTarget.value)}
        rightSection={
          <LegacyActionIcon
            color="gray"
            variant="subtle"
            onClick={() => setSearchText('')}
            disabled={!searchText.length}
          >
            <IconX size={16} />
          </LegacyActionIcon>
        }
      />

      <VirtualRowList
        rows={rows}
        estimateSize={estimateSize}
        getKey={getKey}
        renderRow={renderRow}
      />
    </Stack>
  );
};
