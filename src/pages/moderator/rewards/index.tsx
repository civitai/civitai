import {
  Center,
  Container,
  Group,
  Loader,
  LoadingOverlay,
  Pagination,
  Table,
  Text,
  ThemeIcon,
  Stack,
  Title,
  Button,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { BuzzWithdrawalRequestStatus } from '@prisma/client';
import { IconCloudOff, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { PurchasableRewardsFiltersDropdown } from '~/components/PurchasableRewards/PurchasableRewardsFiltersDropdown';
import { PurchasableRewardsFiltersModeratorDropdown } from '~/components/PurchasableRewards/PurchasableRewardsModeratorFiltersDropdown';
import { useQueryPurchasableRewardsModerator } from '~/components/PurchasableRewards/purchasableRewards.util';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { GetPaginatedPurchasableRewardsModeratorSchema } from '~/server/schema/purchasable-reward.schema';
import { formatDate } from '~/utils/date-helpers';

import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

export default function Rewards() {
  const [filters, setFilters] = useState<
    Omit<GetPaginatedPurchasableRewardsModeratorSchema, 'limit'>
  >({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { purchasableRewards, pagination, isLoading, isRefetching } =
    useQueryPurchasableRewardsModerator(debouncedFilters);

  const handleUpdate = (requestId: string, status: BuzzWithdrawalRequestStatus) => {
    console.log('Well well well');
  };

  return (
    <Container size="lg">
      <Stack spacing={0} mb="xl">
        <Title order={1}>Purchasable Rewards</Title>
        <Text size="sm" color="dimmed">
          Manage the rewards that users can purchase with their Buzz.
        </Text>
      </Stack>
      <Group position="apart" mb="md">
        <Group>
          <Button
            component={NextLink}
            href="/moderator/rewards/create"
            leftIcon={<IconPlus size={16} />}
            radius="xl"
          >
            Create
          </Button>
        </Group>
        <Group>
          <PurchasableRewardsFiltersModeratorDropdown
            setFilters={(f) => setFilters({ ...filters, ...f })}
            filters={filters}
          />
        </Group>
      </Group>
      {isLoading ? (
        <Center p="xl">
          <Loader />
        </Center>
      ) : !!purchasableRewards.length ? (
        <div style={{ position: 'relative' }}>
          <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

          <Table>
            <thead>
              <tr>
                <th>Created by</th>
                <th>Name</th>
                <th>Price (Buzz)</th>
                <th>Usage</th>
                <th>Available From</th>
                <th>Available To</th>
                <th>Archived</th>
                <th>Available slots</th>
                <th>&nbsp;</th>
              </tr>
            </thead>
            <tbody>
              {purchasableRewards.map((purchasableReward) => {
                return (
                  <tr key={purchasableReward.id}>
                    <td>
                      <UserAvatar size="sm" user={purchasableReward.addedBy} withUsername />
                    </td>
                    <td>{purchasableReward.title}</td>
                    <td>{numberWithCommas(purchasableReward.unitPrice)}</td>
                    <td>{getDisplayName(purchasableReward.usage)}</td>
                    <td>
                      {purchasableReward.availableFrom
                        ? formatDate(purchasableReward.availableFrom)
                        : 'N/A'}
                    </td>
                    <td>
                      {purchasableReward.availableTo
                        ? formatDate(purchasableReward.availableTo)
                        : 'N/A'}
                    </td>
                    <td>{purchasableReward.archived ? 'Y' : 'N'}</td>
                    <td>
                      {purchasableReward.availableCount
                        ? `${purchasableReward._count.purchases}/${purchasableReward.availableCount}`
                        : 'N/A'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            {pagination && pagination.totalPages > 1 && (
              <Group position="apart">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  page={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
          </Table>
        </div>
      ) : (
        <Stack align="center">
          <ThemeIcon size={62} radius={100}>
            <IconCloudOff />
          </ThemeIcon>
          <Text align="center">Looks like no purchasable rewards have been created.</Text>
        </Stack>
      )}
    </Container>
  );
}
