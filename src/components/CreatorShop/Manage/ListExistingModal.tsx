import {
  Box,
  Button,
  Center,
  Group,
  Loader,
  Modal,
  MultiSelect,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCheck, IconPackageOff, IconPlus, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import type { CreatorShopPublicShopItem } from '~/components/CreatorShop/creator-shop.util';
import {
  useMutateCreatorShop,
  useQueryPublicShopItems,
} from '~/components/CreatorShop/creator-shop.util';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import type { CosmeticType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';
import { getDisplayName } from '~/utils/string-helpers';

function PublicShopItemCard({
  item,
  onAdd,
  adding,
  added,
}: {
  item: CreatorShopPublicShopItem;
  onAdd: () => void;
  adding: boolean;
  added: boolean;
}) {
  return (
    <Paper withBorder radius="md" p="xs">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <CosmeticThumb data={item.cosmetic.data} name={item.cosmetic.name} />
        <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600} lineClamp={1}>
            {item.cosmetic.name}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {getDisplayName(item.cosmetic.type)}
            {item.addedBy?.username ? ` · by @${item.addedBy.username}` : ''}
          </Text>
          <Text size="xs">
            {numberWithCommas(item.unitAmount)} Buzz · you keep{' '}
            <Text span c="green" fw={600}>
              {item.sellerShare}%
            </Text>
          </Text>
          <Button
            size="compact-xs"
            variant="light"
            mt={4}
            leftSection={added ? <IconCheck size={14} /> : <IconPlus size={14} />}
            loading={adding}
            disabled={added}
            onClick={onAdd}
          >
            {added ? 'Added' : 'Add to my shop'}
          </Button>
        </Stack>
      </Group>
    </Paper>
  );
}

export function ListExistingModal() {
  const dialog = useDialogContext();
  const { addResoldItem } = useMutateCreatorShop();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 400);
  const [types, setTypes] = useState<CosmeticType[]>([]);
  const { items, isLoading, isFetching, fetchNextPage, hasNextPage } = useQueryPublicShopItems({
    query: debouncedSearch.trim() || undefined,
    cosmeticTypes: types.length ? types : undefined,
  });

  const [addedIds, setAddedIds] = useState<Set<number>>(() => new Set());
  const [addingId, setAddingId] = useState<number | null>(null);

  const handleAdd = async (item: CreatorShopPublicShopItem) => {
    setAddingId(item.id);
    try {
      await addResoldItem.mutateAsync({ shopItemId: item.id });
      setAddedIds((prev) => new Set(prev).add(item.id));
    } catch {
      // surfaced by the mutation hook
    } finally {
      setAddingId(null);
    }
  };

  return (
    <Modal {...dialog} size="lg" title="Resell a cosmetic">
      <Stack>
        <Text size="sm" c="dimmed">
          Add cosmetics other creators have made available to your shop. The original creator keeps
          their inventory and price — you earn the seller share on each sale through your shop.
        </Text>

        <Group grow align="flex-start" wrap="wrap">
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search by name or creator"
            leftSection={<IconSearch size={16} />}
          />
          <MultiSelect
            data={cosmeticTypeOptions}
            value={types}
            onChange={(v) => setTypes(v as CosmeticType[])}
            placeholder={types.length ? undefined : 'All types'}
            clearable
            searchable={false}
          />
        </Group>

        {isLoading ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : items.length === 0 ? (
          <Paper withBorder radius="md" p="xl">
            <Stack align="center" gap={6}>
              <ThemeIcon variant="light" color="gray" radius="xl" size={44}>
                <IconPackageOff size={22} />
              </ThemeIcon>
              <Text size="sm" fw={600}>
                No cosmetics available to resell yet.
              </Text>
            </Stack>
          </Paper>
        ) : (
          <Box mah={400} style={{ overflowY: 'auto' }}>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              {items.map((item) => (
                <PublicShopItemCard
                  key={item.id}
                  item={item}
                  onAdd={() => handleAdd(item)}
                  adding={addingId === item.id}
                  added={addedIds.has(item.id)}
                />
              ))}
            </SimpleGrid>
            {hasNextPage && (
              <InViewLoader
                loadFn={fetchNextPage}
                loadCondition={!isFetching}
                className="mt-3 flex justify-center"
              >
                <Loader size="sm" />
              </InViewLoader>
            )}
          </Box>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Done
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
