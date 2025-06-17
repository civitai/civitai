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
import type {
  CosmeticShopItemMeta,
  GetPaginatedCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import { formatDate } from '~/utils/date-helpers';
import { showSuccessNotification } from '~/utils/notifications';
import { getDisplayName } from '~/utils/string-helpers';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';

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
        <Stack gap={0}>
          <Text size="sm">Are you sure you want to delete this Shop item?</Text>
          <Text size="xs" c="dimmed">
            Items with purchases cannot be deleted. Instead, please mark them as archived.
          </Text>
        </Stack>
      ),
      groupProps: { justify: 'center' },
      labels: { confirm: 'Delete Shop Item', cancel: "No, don't delete it" },
      confirmProps: { color: 'red' },
      onConfirm: () => onDelete(),
    });
  };

  return (
    <>
      <Meta title="Cosmetic Shop Products" deIndex />
      <Container size="lg">
        <Stack gap={0} mb="xl">
          <Group>
            <BackButton url="/moderator/cosmetic-store" />
            <Title order={1}>Cosmetic Shop Products</Title>
          </Group>
          <Text size="sm" c="dimmed">
            You can add and manage shop products here. A cosmetic must be created before hand for it
            to be created into a shop product. After creating, remember to add it to a section{' '}
            <Anchor component={Link} href="/moderator/cosmetic-store/sections">
              here.
            </Anchor>
          </Text>
        </Stack>
        <Group justify="space-between" mb="md">
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
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Title</Table.Th>
                  <Table.Th>Cosmetic Name</Table.Th>
                  <Table.Th>Type</Table.Th>
                  <Table.Th>Sample</Table.Th>
                  <Table.Th style={{ width: '135px' }}>Price</Table.Th>
                  <Table.Th>Purchases</Table.Th>
                  <Table.Th>Available From</Table.Th>
                  <Table.Th>Available To</Table.Th>
                  <Table.Th>Remaining Quantity</Table.Th>
                  <Table.Th>Archived At</Table.Th>
                  <Table.Th>&nbsp;</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {cosmeticShopItems.map((shopItem) => {
                  const meta = (shopItem.meta ?? {}) as CosmeticShopItemMeta;
                  return (
                    <Table.Tr key={shopItem.id}>
                      <Table.Td>
                        <Stack gap={0} maw={350}>
                          <Text fw="bold">{shopItem.title}</Text>
                          {shopItem.description && (
                            <ContentClamp maxHeight={200}>
                              <RenderHtml html={shopItem.description} />
                            </ContentClamp>
                          )}
                        </Stack>
                      </Table.Td>
                      <Table.Td>
                        <Stack gap={0} maw={350} align="flex-start">
                          <Text>{shopItem.cosmetic.name}</Text>
                        </Stack>
                      </Table.Td>
                      <Table.Td>{getDisplayName(shopItem.cosmetic.type)}</Table.Td>
                      <Table.Td>
                        <Center>
                          <CosmeticSample cosmetic={shopItem.cosmetic} />
                        </Center>
                      </Table.Td>
                      <Table.Td>
                        <CurrencyBadge unitAmount={shopItem.unitAmount} currency={Currency.BUZZ} />
                      </Table.Td>
                      <Table.Td>{meta.purchases ?? 0}</Table.Td>
                      <Table.Td>
                        {shopItem.availableFrom ? formatDate(shopItem.availableFrom) : '-'}
                      </Table.Td>
                      <Table.Td>
                        {shopItem.availableTo ? formatDate(shopItem.availableTo) : '-'}
                      </Table.Td>
                      <Table.Td>
                        {(shopItem.availableQuantity ?? null) !== null
                          ? `${Math.max(
                              0,
                              (shopItem.availableQuantity ?? 0) - (meta.purchases ?? 0)
                            )}/${shopItem.availableQuantity}`
                          : '-'}
                      </Table.Td>{' '}
                      <Table.Td>
                        {shopItem.archivedAt ? formatDate(shopItem.archivedAt) : '-'}
                      </Table.Td>
                      <Table.Td>
                        <Group gap={4} wrap="nowrap">
                          <LegacyActionIcon
                            component={Link}
                            href={`/moderator/cosmetic-store/products/${shopItem.id}/edit`}
                          >
                            <IconEdit />
                          </LegacyActionIcon>
                          <LegacyActionIcon onClick={() => handleDeleteItem(shopItem.id)}>
                            <IconTrash />
                          </LegacyActionIcon>
                        </Group>
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
            <Text align="center">Looks like no shop items have been created yet. Start now!.</Text>
          </Stack>
        )}
      </Container>
    </>
  );
}
