import {
  ActionIcon,
  Box,
  Button,
  Center,
  Divider,
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
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import {
  IconArrowsMove,
  IconCheck,
  IconPackageOff,
  IconPlus,
  IconSearch,
  IconX,
} from '@tabler/icons-react';
import { useState } from 'react';
import type { DragEndEvent, UniqueIdentifier } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CosmeticThumb } from '~/components/CreatorShop/CosmeticThumb';
import type {
  CreatorShopManageResoldItem,
  CreatorShopPublicShopItem,
} from '~/components/CreatorShop/creator-shop.util';
import {
  useMutateCreatorShop,
  useQueryManageResoldItems,
  useQueryPublicShopItems,
} from '~/components/CreatorShop/creator-shop.util';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { InViewLoader } from '~/components/InView/InViewLoader';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
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

function ResoldListRow({
  item,
  onRemove,
  removing,
}: {
  item: CreatorShopManageResoldItem;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <Paper withBorder radius="md" p="xs">
      <Group gap="xs" wrap="nowrap">
        <IconArrowsMove size={18} className="shrink-0 cursor-grab text-gray-6 dark:text-dark-2" />
        <CosmeticThumb data={item.cosmetic.data} name={item.cosmetic.name} />
        <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
          <Text size="sm" fw={600} lineClamp={1}>
            {item.cosmetic.name}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {getDisplayName(item.cosmetic.type)}
            {item.addedBy?.username ? ` · by @${item.addedBy.username}` : ''}
          </Text>
        </Stack>
        <ActionIcon
          color="red"
          variant="subtle"
          loading={removing}
          onClick={onRemove}
          aria-label={`Remove ${item.cosmetic.name}`}
        >
          <IconX size={16} />
        </ActionIcon>
      </Group>
    </Paper>
  );
}

export function ListExistingModal() {
  const dialog = useDialogContext();
  const { addResoldItem, removeResoldItem, reorderResoldItems } = useMutateCreatorShop();

  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, 400);
  const [types, setTypes] = useState<CosmeticType[]>([]);
  const { items, isLoading, isFetching, fetchNextPage, hasNextPage } = useQueryPublicShopItems({
    query: debouncedSearch.trim() || undefined,
    cosmeticTypes: types.length ? types : undefined,
  });

  const { items: resoldItems, isLoading: resoldLoading } = useQueryManageResoldItems();

  const [addedIds, setAddedIds] = useState<Set<number>>(() => new Set());
  const [busyId, setBusyId] = useState<number | null>(null);

  // Local copy so drag reordering feels instant; reseed when the query changes.
  const [order, setOrder] = useState<CreatorShopManageResoldItem[]>(resoldItems);
  useDidUpdate(() => setOrder(resoldItems), [resoldItems]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleAdd = async (item: CreatorShopPublicShopItem) => {
    setBusyId(item.id);
    try {
      await addResoldItem.mutateAsync({ shopItemId: item.id });
      setAddedIds((prev) => new Set(prev).add(item.id));
    } catch {
      // surfaced by the mutation hook
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (item: CreatorShopManageResoldItem) => {
    setBusyId(item.id);
    try {
      await removeResoldItem.mutateAsync({ shopItemId: item.id });
      setAddedIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
    } catch {
      // surfaced by the mutation hook
    } finally {
      setBusyId(null);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = order.map((i): UniqueIdentifier => i.id);
    const next = arrayMove(order, ids.indexOf(active.id), ids.indexOf(over.id));
    setOrder(next);
    reorderResoldItems.mutate({ resoldItemIds: next.map((i) => i.id) });
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
          <Box mah={320} style={{ overflowY: 'auto' }}>
            <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
              {items.map((item) => (
                <PublicShopItemCard
                  key={item.id}
                  item={item}
                  onAdd={() => handleAdd(item)}
                  adding={busyId === item.id}
                  added={item.isResold || addedIds.has(item.id)}
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

        <Divider />

        <Stack gap={4}>
          <Text fw={600}>Your resell listings</Text>
          <Text size="xs" c="dimmed">
            Drag to reorder how they appear in your shop&apos;s &quot;From other creators&quot;
            section.
          </Text>
        </Stack>

        {resoldLoading ? (
          <Center py="lg">
            <Loader size="sm" />
          </Center>
        ) : order.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="sm">
            You aren&apos;t reselling any cosmetics yet.
          </Text>
        ) : (
          <Box mah={280} style={{ overflowY: 'auto' }}>
            <DndContext
              sensors={sensors}
              collisionDetection={rectIntersection}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={order.map((i) => i.id)}
                strategy={verticalListSortingStrategy}
              >
                <Stack gap="xs">
                  {order.map((item) => (
                    <SortableItem key={item.id} id={item.id}>
                      <ResoldListRow
                        item={item}
                        onRemove={() => handleRemove(item)}
                        removing={busyId === item.id}
                      />
                    </SortableItem>
                  ))}
                </Stack>
              </SortableContext>
            </DndContext>
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
