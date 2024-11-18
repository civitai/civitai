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
  ActionIcon,
  Box,
  TextInput,
  Badge,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { NextLink } from '@mantine/next';
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
import { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { ContentDecorationCosmetic } from '~/server/selectors/cosmetic.selector';
import { CosmeticGetById } from '~/types/router';

import { trpc } from '~/utils/trpc';

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
        <Stack spacing="xl">
          <Text weight="bold" align="center">
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
          <Stack spacing="xl">
            <Text weight="bold" align="center">
              Preview
            </Text>
            <Text size="sm" color="dimmed" align="center">
              You can apply this cosmetic to any image, model, article or post you own.
            </Text>
          </Stack>
          <Box mx="auto">
            <PreviewCard
              decoration={cosmetic as ContentDecorationCosmetic}
              image={images[activeImageIndex]}
            />
          </Box>
          <Group spacing="xs" position="center">
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
