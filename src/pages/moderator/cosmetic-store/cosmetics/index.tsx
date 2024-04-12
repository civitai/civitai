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
  ActionIcon,
  Box,
  TextInput,
  Badge,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
import { BuzzWithdrawalRequestStatus, CosmeticType } from '@prisma/client';
import { IconCloudOff, IconEdit, IconPlus } from '@tabler/icons-react';
import { useState } from 'react';
import { CosmeticsFiltersDropdown } from '~/components/Cosmetics/CosmeticsFiltersDropdown';
import { useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { PurchasableRewardModeratorViewMode } from '~/server/common/enums';
import { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { GetPaginatedPurchasableRewardsModeratorSchema } from '~/server/schema/purchasable-reward.schema';
import { NamePlateCosmetic } from '~/server/selectors/cosmetic.selector';
import { CosmeticGetById } from '~/types/router';

import { trpc } from '~/utils/trpc';

const cosmeticSampleSizeMap: Record<
  'sm' | 'md' | 'lg',
  { badgeSize: number; textSize: string; avatarSize: string }
> = {
  sm: { badgeSize: 50, textSize: 'sm', avatarSize: 'md' },
  md: { badgeSize: 100, textSize: 'md', avatarSize: 'lg' },
  lg: { badgeSize: 150, textSize: 'lg', avatarSize: 'lg' },
};

export const CosmeticSample = ({
  cosmetic,
  size = 'sm',
}: {
  cosmetic: Pick<CosmeticGetById, 'id' | 'data' | 'type' | 'name' | 'source'>;
  size?: 'sm' | 'md' | 'lg';
}) => {
  const currentUser = useCurrentUser();
  const { data: user } = trpc.user.getById.useQuery(
    { id: currentUser?.id ?? 0 },
    { enabled: !!currentUser }
  );
  const values = cosmeticSampleSizeMap[size];

  if (!user) {
    return <Loader />;
  }

  switch (cosmetic.type) {
    case CosmeticType.Badge:
      return (
        <Box w={values.badgeSize}>
          <EdgeMedia
            src={(cosmetic.data as { url: string })?.url}
            alt={cosmetic.name}
            width="original"
          />
        </Box>
      );
    case CosmeticType.NamePlate:
      const data = cosmetic.data as NamePlateCosmetic['data'];
      return (
        <Text weight="bold" {...data} size={values.textSize}>
          {user.username ?? 'Username'}
        </Text>
      );
    case CosmeticType.ProfileDecoration:
      // TODO.cosmetic-shop: Confirm this is enough?
      return (
        <UserAvatar
          user={{
            ...user,
            cosmetics: [{ data: {}, cosmetic }],
          }}
          size={values.avatarSize}
        />
      );
    case CosmeticType.ContentDecoration:
      // TODO.cosmetic-shop: Implement this
      return null;
    default:
      return null;
  }
};

export default function CosmeticStoreProducts() {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticsInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
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
        <Stack spacing={0} mb="xl">
          <Title order={1}>Available Cosmetics</Title>
          <Text size="sm" color="dimmed">
            You can view manage all available cosmetics here, and create new shop items from this
            page.
          </Text>
          <Text size="sm" color="dimmed">
            The ability to create cosmetics from this &amo; grant it to users will be coming soon
            (TM).
          </Text>
        </Stack>
        <Group position="apart" mb="md">
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
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>Sample</th>
                  <th>Shop Items</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {cosmetics.map((cosmetic) => {
                  return (
                    <tr key={cosmetic.id}>
                      <td>
                        <Stack spacing={0} maw={350}>
                          <Text>{cosmetic.name}</Text>
                          <Text color="dimmed" size="sm">
                            {cosmetic.description}
                          </Text>
                        </Stack>
                      </td>
                      <td>{cosmetic.type}</td>
                      <td>
                        <CosmeticSample cosmetic={cosmetic} />
                      </td>
                      <td>
                        <Badge color={cosmetic._count?.cosmeticShopItems > 0 ? 'blue' : 'gray'}>
                          {cosmetic._count?.cosmeticShopItems} Shop items
                        </Badge>
                      </td>
                      <td>
                        <ActionIcon component={NextLink} href={`/moderator/rewards/update/test`}>
                          <IconEdit />
                        </ActionIcon>
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
    </>
  );
}
