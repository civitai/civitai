import { ActionIcon, Center, Divider, Loader, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconAlertCircle, IconSearch, IconX } from '@tabler/icons-react';
import React, { useCallback, useMemo, useState } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { AuctionTopSection } from '~/components/Auction/AuctionInfo';
import { ModelMyBidCard, ModelMyRecurringBidCard } from '~/components/Auction/AuctionPlacementCard';
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
          <ActionIcon onClick={() => setSearchText('')} disabled={!searchText.length}>
            <IconX size={16} />
          </ActionIcon>
        }
      />

      <Divider my="sm" />

      <Title order={5}>Active Bids</Title>
      {isLoadingBidData ? (
        <Center my="lg">
          <Loader />
        </Center>
      ) : isErrorBidData ? (
        <Center my="lg">
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching your bid data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !activeBids.length ? (
        <Center my="lg">
          <Stack gap="xs" className="text-center">
            <Text>No active bids.</Text>
            <Text>Choose an auction in the list to get started.</Text>
          </Stack>
        </Center>
      ) : (
        <Stack>
          {activeBids.map((ab) => (
            <ModelMyBidCard
              key={`${ab.auction.id}-${ab.entityId}`}
              data={ab}
              searchText={searchText}
            />
          ))}
        </Stack>
      )}

      <Divider my="sm" />

      <Title order={5}>Recurring Bids</Title>
      {isLoadingBidRecurringData ? (
        <Center my="lg">
          <Loader />
        </Center>
      ) : isErrorBidRecurringData ? (
        <Center my="lg">
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching your bid data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !recurringBids.length ? (
        <Center my="lg">
          <Stack>
            <Text>No recurring bids.</Text>
          </Stack>
        </Center>
      ) : (
        <Stack>
          {recurringBids.map((ab) => (
            <ModelMyRecurringBidCard
              key={`${ab.auctionBase.id}-${ab.entityId}`}
              data={ab}
              searchText={searchText}
            />
          ))}
        </Stack>
      )}

      <Divider my="sm" />

      <Title order={5}>Past Bids</Title>
      {isLoadingBidData ? (
        <Center my="lg">
          <Loader />
        </Center>
      ) : isErrorBidData ? (
        <Center my="lg">
          <AlertWithIcon icon={<IconAlertCircle />} color="red" iconColor="red">
            <Text>There was an error fetching your bid data. Please try again.</Text>
          </AlertWithIcon>
        </Center>
      ) : !pastBids.length ? (
        <Center my="lg">
          <Stack>
            <Text>No past bids.</Text>
          </Stack>
        </Center>
      ) : (
        <Stack>
          {pastBids.map((ab) => (
            <ModelMyBidCard
              key={`${ab.auction.id}-${ab.entityId}`}
              data={ab}
              searchText={searchText}
            />
          ))}
        </Stack>
      )}
    </Stack>
  );
};
