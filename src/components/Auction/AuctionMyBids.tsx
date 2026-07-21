import { Stack, TextInput, Title } from '@mantine/core';
import { IconSearch, IconX } from '@tabler/icons-react';
import React, { useCallback, useMemo, useState } from 'react';
import { AuctionTopSection } from '~/components/Auction/AuctionInfo';
import { AuctionMyBidsList } from '~/components/Auction/AuctionMyBidsList';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GetMyBidsReturn, GetMyRecurringBidsReturn } from '~/server/services/auction.service';
import { AuctionType } from '~/shared/utils/prisma/enums';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';

export const AuctionMyBids = () => {
  const currentUser = useCurrentUser();
  const [searchText, setSearchText] = useState<string>('');
  const searchLower = searchText.toLowerCase();

  const {
    data: bidData = [],
    isInitialLoading: isInitialLoadingBidData,
    isError: isErrorBidData,
  } = trpc.auction.getMyBids.useQuery(undefined, { enabled: !!currentUser });

  const {
    data: bidRecurringData = [],
    isInitialLoading: isInitialLoadingBidRecurringData,
    isError: isErrorBidRecurringData,
  } = trpc.auction.getMyRecurringBids.useQuery(undefined, { enabled: !!currentUser });

  // Only the initial load swaps rows for skeletons. Folding in `isRefetching` would
  // collapse the list on every window-focus refetch and post-bid invalidation, and the
  // virtualizer clamps the scroll offset to the shrunken list rather than holding place.
  const isLoadingBidData = isInitialLoadingBidData;
  const isLoadingBidRecurringData = isInitialLoadingBidRecurringData;

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

      <AuctionMyBidsList
        activeBids={activeBids}
        recurringBids={recurringBids}
        pastBids={pastBids}
        isLoadingBids={isLoadingBidData}
        isErrorBids={isErrorBidData}
        isLoadingRecurringBids={isLoadingBidRecurringData}
        isErrorRecurringBids={isErrorBidRecurringData}
        searchText={searchText}
      />
    </Stack>
  );
};
