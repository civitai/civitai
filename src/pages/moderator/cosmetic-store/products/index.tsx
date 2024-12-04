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
  TextInput,
  Anchor,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { openConfirmModal } from '@mantine/modals';
import { NextLink as Link } from '~/components/NextLink/NextLink';
import { Currency } from '~/shared/utils/prisma/enums';
import { IconCloudOff, IconEdit, IconPlus, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { BackButton } from '~/components/BackButton/BackButton';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import {
  useMutateCosmeticShop,
  useQueryCosmeticShopItemsPaged,
} from '~/components/CosmeticShop/cosmetic-shop.util';
import { CosmeticsFiltersDropdown } from '~/components/Cosmetics/CosmeticsFiltersDropdown';
import { CurrencyBadge } from '~/components/Currency/CurrencyBadge';
import { Meta } from '~/components/Meta/Meta';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import {
  CosmeticShopItemMeta,
  GetPaginatedCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';

export default function CosmeticStoreProducts() {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticShopItemInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const {
    cosmeticShopItems,
    pagination,
    isLoading: isLoadingCosmetics,
    isRefetching,
  } = useQueryCosmeticShopItemsPaged(debouncedFilters);

  const isLoading = isLoadingCosmetics;

  const { deleteShopItem } = useMutateCosmeticShop();

  const handleDeleteItem = (id: number) => {
    const onDelete = async () => {
      await deleteShopItem({ id });
      showSuccessNotification({ message: 'Shop item has been deleted.' });
    };

    openConfirmModal({
      title: 'Delete Item',
      children: (
        <Stack spacing={0}>
          <Text size="sm">Are you sure you want to delete this Shop item?</Text>
          <Text size="xs" color="dimmed">
            Items with purchases cannot be deleted. Instead, please mark them as archived.
          </Text>
        </Stack>
      ),
      groupProps: {
        position: 'center',
      },
      labels: { confirm: 'Delete Shop Item', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => onDelete(),
    });
  };

  return (
    <>
      <Meta title="Cosmetic Shop Products" deIndex />
      <Container size="lg">
        <Stack spacing={0} mb="xl">
          <Group>
            <BackButton url="/moderator/cosmetic-store" />
            <Title order={1}>Cosmetic Shop Products</Title>
          </Group>
          <Text size="sm" color="dimmed">
            You can add and manage shop products here. A cosmetic must be created before hand for it
            to be created into a shop product. After creating, remember to add it to a section{' '}
            <Anchor component={Link} href="/moderator/cosmetic-store/sections">
              here.
            </Anchor>
          </Text>
        </Stack>
        <Group position="apart" mb="md">
          <Group align="flex-end">
            <Button component={Link} href="/moderator/cosmetic-store/products/create" radius="xl">
              <IconPlus />
              Add Product
            </Button>
            <TextInput
              label="Filter by cosmetic name"
              value={filters.name ?? ''}
              onChange={(e) => setFilters({ ...filters, name: e.target.value || undefined })}
              size="sm"
              miw={300}
              radius="xl"
              mb={0}
            />
          </Group>
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
        ) : !!cosmeticShopItems.length ? (
          <div style={{ position: 'relative' }}>
            <LoadingOverlay visible={isRefetching ?? false} zIndex={9} />

            <Table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Cosmetic Name</th>
                  <th>Type</th>
                  <th>
                    <Text align="center">Sample</Text>
                  </th>
                  <th>Price</th>
                  <th>Purchases</th>
                  <th>Available From</th>
                  <th>Available To</th>
                  <th>Remaining Quantity</th>
                  <th>Archived At</th>
                  <th>&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {cosmeticShopItems.map((shopItem) => {
                  const meta = (shopItem.meta ?? {}) as CosmeticShopItemMeta;
                  return (
                    <tr key={shopItem.id}>
                      <td>
                        <Stack spacing={0} maw={350}>
                          <Text weight="bold">{shopItem.title}</Text>
                          {shopItem.description && (
                            <ContentClamp maxHeight={200}>
                              <RenderHtml html={shopItem.description} />
                            </ContentClamp>
                          )}
                        </Stack>
                      </td>
                      <td>
                        <Stack spacing={0} maw={350} align="flex-start">
                          <Text>{shopItem.cosmetic.name}</Text>
                        </Stack>
                      </td>
                      <td>{getDisplayName(shopItem.cosmetic.type)}</td>
                      <td>
                        <Center>
                          <CosmeticSample cosmetic={shopItem.cosmetic} />
                        </Center>
                      </td>
                      <td>
                        <CurrencyBadge unitAmount={shopItem.unitAmount} currency={Currency.BUZZ} />
                      </td>
                      <td>{meta.purchases ?? 0}</td>
                      <td>{shopItem.availableFrom ? formatDate(shopItem.availableFrom) : '-'}</td>
                      <td>{shopItem.availableTo ? formatDate(shopItem.availableTo) : '-'}</td>
                      <td>
                        {(shopItem.availableQuantity ?? null) !== null
                          ? `${Math.max(
                              0,
                              (shopItem.availableQuantity ?? 0) - (meta.purchases ?? 0)
                            )}/${shopItem.availableQuantity}`
                          : '-'}
                      </td>{' '}
                      <td>{shopItem.archivedAt ? formatDate(shopItem.archivedAt) : '-'}</td>
                      <td>
                        <Group spacing={4} noWrap>
                          <ActionIcon
                            component={Link}
                            href={`/moderator/cosmetic-store/products/${shopItem.id}/edit`}
                          >
                            <IconEdit />
                          </ActionIcon>
                          <ActionIcon onClick={() => handleDeleteItem(shopItem.id)}>
                            <IconTrash />
                          </ActionIcon>
                        </Group>
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
            <Text align="center">Looks like no shop items have been created yet. Start now!.</Text>
          </Stack>
        )}
      </Container>
    </>
  );
}
