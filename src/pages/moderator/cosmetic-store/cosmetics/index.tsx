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
  TextInput,
  Badge,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { IconCloudOff, IconEdit } from '@tabler/icons-react';
import { useState } from 'react';
import { CosmeticsFiltersDropdown } from '~/components/Cosmetics/CosmeticsFiltersDropdown';
import { useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { Meta } from '~/components/Meta/Meta';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import type { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { createServerSideProps } from '~/server/utils/server-side-helpers';

import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const getServerSideProps = createServerSideProps({ requireModerator: true });

export default function CosmeticStoreProducts() {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticsInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const {
    cosmetics,
    pagination,
    isLoading: isLoadingCosmetics,
    isRefetching,
  } = useQueryCosmeticsPaged(debouncedFilters);

  const isLoading = isLoadingCosmetics;

  return (
    <>
      <Meta title="Cosmetics" deIndex />
      <Container size="lg">
        <Stack gap={0} mb="xl">
          <Title order={1}>Available Cosmetics</Title>
          <Text size="sm" c="dimmed">
            You can view manage all available cosmetics here, and create new shop items from this
            page.
          </Text>
          <Text size="sm" c="dimmed">
            The ability to create cosmetics from this &amo; grant it to users will be coming soon
            (TM).
          </Text>
        </Stack>
        <Group justify="space-between" mb="md">
          <TextInput
            label="Filter by name"
            value={filters.name ?? ''}
            onChange={(e) => setFilters({ ...filters, name: e.target.value || undefined })}
            size="sm"
            miw={300}
          />
          <Group>
            <CosmeticsFiltersDropdown
              setFilters={(f) => setFilters({ ...filters, ...f })}
              filters={filters}
            />
          </Group>
        </Group>
        {isLoading ? (
          <Center p="xl">
            <Loader />
          </Center>
        ) : !!cosmetics.length ? (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

            <Table>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Sample</Table.Th>
                  <Table.Th>Shop Items</Table.Th>
                  <Table.Th>&nbsp;</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cosmetics.map((cosmetic) => {
                  return (
                    <Table.Tr key={cosmetic.id}>
                      <Table.Td>
                        <Stack gap={0} maw={350}>
                          <Text>{cosmetic.name}</Text>
                          <Text c="dimmed" size="sm">
                            {cosmetic.description}
                          </Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>{cosmetic.type}</Table.Td>
                      <Table.Td>
                        <CosmeticSample cosmetic={cosmetic} />
                      </Table.Td>
                      <Table.Td>
                        <Badge color={cosmetic._count?.cosmeticShopItems > 0 ? 'blue' : 'gray'}>
                          {cosmetic._count?.cosmeticShopItems} Shop items
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <LegacyActionIcon component={Link} href="/moderator/rewards/update/test">
                          <IconEdit />
                        </LegacyActionIcon>
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
            {pagination && pagination.totalPages > 1 && (
              <Group className="mt-4" justify="space-between">
                <Text>Total {pagination.totalItems.toLocaleString()} items</Text>
                <Pagination
                  value={filters.page}
                  onChange={(page) => setFilters((curr) => ({ ...curr, page }))}
                  total={pagination.totalPages}
                />
              </Group>
            )}
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
