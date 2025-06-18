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
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCloudOff, IconEdit, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { Meta } from '~/components/Meta/Meta';
import { PurchasableRewardsFiltersModeratorDropdown } from '~/components/PurchasableRewards/PurchasableRewardsModeratorFiltersDropdown';
import { useQueryPurchasableRewardsModerator } from '~/components/PurchasableRewards/purchasableRewards.util';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { PurchasableRewardModeratorViewMode } from '~/server/common/enums';
import type { GetPaginatedPurchasableRewardsModeratorSchema } from '~/server/schema/purchasable-reward.schema';
import { formatDate } from '~/utils/date-helpers';

import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export default function Rewards() {
  const [filters, setFilters] = useState<
    Omit<GetPaginatedPurchasableRewardsModeratorSchema, 'limit'>
  >({
    page: 1,
    mode: PurchasableRewardModeratorViewMode.Available,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { purchasableRewards, pagination, isLoading, isRefetching } =
    useQueryPurchasableRewardsModerator(debouncedFilters);

  return (
    <>
      <Meta title="Rewards" deIndex />
      <Container size="lg">
        <Stack gap={0} mb="xl">
          <Title order={1}>Purchasable Rewards</Title>
          <Text size="sm" c="dimmed">
            Manage the rewards that users can purchase with their Buzz.
          </Text>
        </Stack>
        <Group justify="space-between" mb="md">
          <Group>
            <Button
              component={Link}
              href="/moderator/rewards/create"
              leftSection={<IconPlus size={16} />}
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
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Created by</Table.Th>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Price (Buzz)</Table.Th>
                  <Table.Th>Usage</Table.Th>
                  <Table.Th>Available From</Table.Th>
                  <Table.Th>Available To</Table.Th>
                  <Table.Th>Archived</Table.Th>
                  <Table.Th>Remaining Codes</Table.Th>
                  <Table.Th>Available slots</Table.Th>
                  <Table.Th>&nbsp;</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {purchasableRewards.map((purchasableReward) => {
                  return (
                    <Table.Tr key={purchasableReward.id}>
                      <Table.Td>
                        <UserAvatar size="sm" user={purchasableReward.addedBy} withUsername />
                      </Table.Td>
                      <Table.Td>{purchasableReward.title}</Table.Td>
                      <Table.Td>{numberWithCommas(purchasableReward.unitPrice)}</Table.Td>
                      <Table.Td>{getDisplayName(purchasableReward.usage)}</Table.Td>
                      <Table.Td>
                        {purchasableReward.availableFrom
                          ? formatDate(purchasableReward.availableFrom)
                          : '-'}
                      </Table.Td>
                      <Table.Td>
                        {purchasableReward.availableTo
                          ? formatDate(purchasableReward.availableTo)
                          : '-'}
                      </Table.Td>
                      <Table.Td>{purchasableReward.archived ? 'Y' : 'N'}</Table.Td>
                      <Table.Td>{purchasableReward.codes.length}</Table.Td>
                      <Table.Td>
                        {purchasableReward.availableCount
                          ? `${
                              purchasableReward.availableCount - purchasableReward._count.purchases
                            }/${purchasableReward.availableCount}`
                          : '-'}
                      </Table.Td>
                      <Table.Td>
                        <LegacyActionIcon
                          component={Link}
                          href={`/moderator/rewards/update/${purchasableReward.id}`}
                        >
                          <IconEdit />
                        </LegacyActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
              {pagination && pagination.totalPages > 1 && (
                <Group justify="space-between">
                  <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                  <Pagination
                    value={filters.page}
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
    </>
  );
}
