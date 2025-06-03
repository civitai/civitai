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
  Box,
  TextInput,
  Badge,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { CosmeticType } from '~/shared/utils/prisma/enums';
import { IconCloudOff, IconEdit } from '@tabler/icons-react';
import { useState } from 'react';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { CosmeticsFiltersDropdown } from '~/components/Cosmetics/CosmeticsFiltersDropdown';
import { useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { CreatorCardV2 } from '~/components/CreatorCard/CreatorCard';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { Meta } from '~/components/Meta/Meta';
import { PreviewCard } from '~/components/Modals/CardDecorationModal';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import type { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import type { CosmeticGetById } from '~/types/router';

import { trpc } from '~/utils/trpc';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

export const CosmeticPreview = ({
  cosmetic,
}: {
  cosmetic: Pick<CosmeticGetById, 'id' | 'data' | 'type' | 'name' | 'source' | 'description'>;
}) => {
  const isProfileRelated =
    cosmetic.type === CosmeticType.Badge ||
    cosmetic.type === CosmeticType.NamePlate ||
    cosmetic.type === CosmeticType.ProfileBackground ||
    cosmetic.type === CosmeticType.ProfileDecoration;

  const currentUser = useCurrentUser();
  const { data: user } = trpc.userProfile.get.useQuery(
    { username: currentUser ? currentUser.username : '' },
    { enabled: !!currentUser?.username && isProfileRelated }
  );
  const browsingLevel = useBrowsingLevelDebounced();
  const { data: images = [] } = trpc.cosmeticShop.getPreviewImages.useQuery(
    {
      browsingLevel: browsingLevel,
    },
    {
      enabled: !!currentUser && !isProfileRelated,
    }
  );
  const [activeImageIndex, setActiveImageIndex] = useState(0);

  if ((!user && isProfileRelated) || (!images && !isProfileRelated)) {
    return (
      <Center>
        <Loader />
      </Center>
    );
  }

  const userWithEquippedCosmetics = user
    ? {
        ...user,
        cosmetics: user?.cosmetics?.filter((c) => !!c.equippedAt) ?? [],
      }
    : undefined;

  switch (cosmetic.type) {
    case CosmeticType.Badge:
    case CosmeticType.ProfileDecoration:
    case CosmeticType.NamePlate:
    case CosmeticType.ProfileBackground:
      if (!userWithEquippedCosmetics) {
        return null;
      }

      return (
        <Stack gap="xl">
          <Text fw="bold" align="center">
            Preview
          </Text>
          <CreatorCardV2 user={userWithEquippedCosmetics} cosmeticOverwrites={[cosmetic]} />
        </Stack>
      );
    case CosmeticType.ContentDecoration:
      if (!images.length) {
        return null;
      }

      return (
        <Stack>
          <Stack gap="xl">
            <Text fw="bold" align="center">
              Preview
            </Text>
            <Text size="sm" c="dimmed" align="center">
              You can apply this cosmetic to any image, model, article or post you own.
            </Text>
          </Stack>
          <Box mx="auto">
            <PreviewCard
              decoration={cosmetic as ContentDecorationCosmetic}
              image={images[activeImageIndex]}
            />
          </Box>
          <Group gap="xs" justify="center">
            {images.map((image, index) => {
              const isSelected = index === activeImageIndex;
              return (
                <UnstyledButton
                  key={image.id}
                  onClick={() => setActiveImageIndex(index)}
                  style={{
                    opacity: isSelected ? 1 : 0.5,
                    width: 40,
                    height: 50,
                    borderRadius: 5,
                    overflow: 'hidden',
                  }}
                >
                  <EdgeMedia
                    style={{ objectFit: 'cover', width: '100%', height: '100%' }}
                    src={image.url}
                    width={100}
                  />
                </UnstyledButton>
              );
            })}
          </Group>{' '}
        </Stack>
      );
    default:
      return null;
  }
};

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
