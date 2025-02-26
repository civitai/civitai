import { Button, Center, Divider, Group, Loader, Stack, Text, Title } from '@mantine/core';
import { IconAlertCircle, IconLayoutSidebarLeftExpand } from '@tabler/icons-react';
import React, { useMemo } from 'react';
import { AlertWithIcon } from '~/components/AlertWithIcon/AlertWithIcon';
import { ModelMyBidCard, ModelMyRecurringBidCard } from '~/components/Auction/AuctionPlacementCard';
import { useAuctionContext } from '~/components/Auction/AuctionProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export const AuctionMyBids = () => {
  const currentUser = useCurrentUser();
  const { drawerToggle } = useAuctionContext();

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

  const activeBids = useMemo(() => bidData.filter((bd) => bd.isActive), [bidData]);
  const pastBids = useMemo(() => bidData.filter((bd) => !bd.isActive), [bidData]);

  return (
    <Stack w="100%" spacing="sm">
      {/*<Group className="sticky top-0 right-0">*/}
      <Group position="right">
        <Button className="sm:hidden" onClick={drawerToggle} variant="default">
          <Group spacing={4}>
            <IconLayoutSidebarLeftExpand />
            All Auctions
          </Group>
        </Button>
      </Group>

      <Title order={3}>My Bids</Title>
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
          <Stack>
            <Text>No active bids.</Text>
            <Text>Choose an auction in the list to get started.</Text>
          </Stack>
        </Center>
      ) : (
        <Stack>
          {activeBids.map((ab) => (
            <ModelMyBidCard key={`${ab.auction.id}-${ab.entityId}`} data={ab} />
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
      ) : !bidRecurringData.length ? (
        <Center my="lg">
          <Stack>
            <Text>No recurring bids.</Text>
          </Stack>
        </Center>
      ) : (
        <Stack>
          {bidRecurringData.map((ab) => (
            <ModelMyRecurringBidCard key={`${ab.auctionBase.id}-${ab.entityId}`} data={ab} />
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
            <ModelMyBidCard key={`${ab.auction.id}-${ab.entityId}`} data={ab} />
          ))}
        </Stack>
      )}
    </Stack>
  );
};
