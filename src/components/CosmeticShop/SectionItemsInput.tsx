import type { InputWrapperProps } from '@mantine/core';
import {
  Badge,
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Input,
  Loader,
  Pagination,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Grid,
} from '@mantine/core';
import React, { useMemo, useState } from 'react';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { IconTrash } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import type { CosmeticShopItemGetById } from '~/types/router';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { UserAvatar } from '~/components/UserAvatar/UserAvatar';
import { useQueryCosmeticShopItemsPaged } from '~/components/CosmeticShop/cosmetic-shop.util';
import type { GetPaginatedCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
import { isDefined } from '~/utils/type-guards';
import { withController } from '~/libs/form/hoc/withController';
import { getDisplayName } from '~/utils/string-helpers';
import { formatDate } from '~/utils/date-helpers';
import { trpc } from '~/utils/trpc';
import type { ShopItemFeaturedHistory } from '~/server/services/cosmetic-shop-featured-log.service';

type ShopItemSchema = { title: string; description?: string; id: number };

type SectionItemsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ShopItemSchema[];
  onChange?: (value: ShopItemSchema[]) => void;
};

const CosmeticShopItemOption = ({ item }: { item: CosmeticShopItemGetById }) => {
  return (
    <Group gap="sm" wrap="nowrap" w="100%">
      {/* Fixed-width well — profile-background samples render at width 100% and
          would otherwise crush the text column. */}
      <Box w={72} miw={72} style={{ display: 'flex', justifyContent: 'center' }}>
        {item.cosmetic && <CosmeticSample cosmetic={item.cosmetic} size="sm" />}
      </Box>
      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={500} lineClamp={1}>
          {item.title}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {item.cosmetic ? getDisplayName(item.cosmetic.type) : 'Pack'}
          {item.cosmetic?.creator?.username ? ` · by @${item.cosmetic.creator.username}` : ''}
        </Text>
      </Stack>
    </Group>
  );
};

const PICKER_PAGE_SIZE = 20;

export const FeaturedHistoryBadge = ({ history }: { history?: ShopItemFeaturedHistory }) => {
  if (!history) return null;
  if (history.currentSections.length)
    return (
      <Badge
        size="xs"
        color="green"
        variant="light"
        title={history.currentSections.map((s) => s.title).join(', ')}
      >
        Featured now
      </Badge>
    );
  if (history.lastFeaturedAt)
    return (
      <Badge size="xs" color="gray" variant="light">
        Featured before ({formatDate(history.lastFeaturedAt)})
      </Badge>
    );
  return null;
};

const CosmeticShopItemSearch = ({
  selectedIds,
  onItemSelected,
}: {
  selectedIds: number[];
  onItemSelected: (item: CosmeticShopItemGetById) => void;
}) => {
  const [filters, setFilters] = useState<GetPaginatedCosmeticShopItemInput>({
    page: 1,
    limit: PICKER_PAGE_SIZE,
    // Archived cosmetics can't be sold, so they must not be featurable.
    archived: false,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const {
    cosmeticShopItems = [],
    pagination,
    isFetching,
  } = useQueryCosmeticShopItemsPaged(debouncedFilters, { keepPreviousData: true });
  const searching = isFetching || !isEqual(filters, debouncedFilters);
  const items = cosmeticShopItems.filter(isDefined);
  const pageIds = items.map((i) => i.id);
  const { data: history } = trpc.cosmeticShop.getShopItemsFeaturedHistory.useQuery(
    { ids: pageIds },
    { enabled: pageIds.length > 0 }
  );

  return (
    <Stack gap={6}>
      <TextInput
        label="Search products"
        description="Search by title, cosmetic name, or creator username / id, then add items to this section"
        value={filters.name ?? ''}
        onChange={(e) => {
          const name = e.currentTarget.value;
          setFilters((f) => ({ ...f, name, page: 1 }));
        }}
        rightSection={searching ? <Loader size="xs" /> : null}
        withAsterisk
      />
      <Checkbox
        size="xs"
        label="Published creator cosmetics only"
        description="Published creator-shop items, newest approved first."
        checked={!!filters.publishedCreatorOnly}
        onChange={(e) => {
          const publishedCreatorOnly = e.currentTarget.checked || undefined;
          setFilters((f) => ({ ...f, publishedCreatorOnly, page: 1 }));
        }}
      />
      <Paper withBorder radius="md">
        <ScrollArea.Autosize mah={360}>
          {items.length ? (
            <Stack gap={0}>
              {items.map((item) => {
                const added = selectedIds.includes(item.id);
                return (
                  <Group
                    key={item.id}
                    gap="xs"
                    wrap="nowrap"
                    px="sm"
                    py={6}
                    data-testid="section-picker-row"
                  >
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <CosmeticShopItemOption item={item} />
                    </Box>
                    <FeaturedHistoryBadge history={history?.[item.id]} />
                    <Button
                      size="compact-xs"
                      variant={added ? 'default' : 'light'}
                      disabled={added}
                      onClick={() => onItemSelected(item)}
                    >
                      {added ? 'Added' : 'Add'}
                    </Button>
                  </Group>
                );
              })}
            </Stack>
          ) : (
            <Center p="sm">
              <Text size="sm" c="dimmed">
                {searching ? 'Searching…' : 'No items match'}
              </Text>
            </Center>
          )}
        </ScrollArea.Autosize>
      </Paper>
      {!!pagination && pagination.totalPages > 1 && (
        <Pagination
          size="sm"
          total={pagination.totalPages}
          value={filters.page ?? 1}
          onChange={(page) => setFilters((f) => ({ ...f, page }))}
        />
      )}
    </Stack>
  );
};

export const SectionItemsInput = ({ value, onChange, ...props }: SectionItemsInputProps) => {
  const [shopItems, setSelectedShopItems] = useState<ShopItemSchema[]>(value || []);
  const [error, setError] = useState('');

  // Hydrate previews/attribution/cut for the selected cards straight from the
  // server — the form value only carries {id, title}, so carried state can
  // never go stale.
  const selectedIds = useMemo(() => shopItems.map((i) => i.id).sort((a, b) => a - b), [shopItems]);
  const { cosmeticShopItems: selectedDetails = [] } = useQueryCosmeticShopItemsPaged(
    { ids: selectedIds, limit: 200 },
    { enabled: selectedIds.length > 0 }
  );
  const detailsById = useMemo(
    () => new Map(selectedDetails.filter(isDefined).map((i) => [i.id, i])),
    [selectedDetails]
  );

  useDidUpdate(() => {
    if (shopItems) {
      onChange?.(shopItems);
    }
  }, [shopItems]);

  useDidUpdate(() => {
    if (!isEqual(value, shopItems)) {
      // Value changed outside.
      setSelectedShopItems(value || []);
    }
  }, [value]);

  const onItemSelected = (item: CosmeticShopItemGetById) => {
    if (shopItems.find((i) => i.id === item.id)) {
      // This already has been added.
      return;
    }

    setSelectedShopItems((current) => [
      ...current,
      { title: item.title, description: item.description ?? undefined, id: item.id },
    ]);
  };

  const onRemoveSelectedItem = (itemId: number) => {
    setSelectedShopItems((current) => current.filter((i) => !(i.id === itemId)));
  };

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setSelectedShopItems((items) => {
        const ids = items.map((item) => item.id);
        const oldIndex = ids.indexOf(active.id as number);
        const newIndex = ids.indexOf(over.id as number);
        const sorted = arrayMove(items, oldIndex, newIndex);
        return sorted;
      });
    }
  };

  return (
    <Input.Wrapper {...props} error={props.error ?? error}>
      <Stack gap="xs" mt="sm">
        <CosmeticShopItemSearch
          selectedIds={shopItems.map((i) => i.id)}
          onItemSelected={onItemSelected}
        />
        <Paper mt="md">
          <DndContext
            sensors={sensors}
            collisionDetection={rectIntersection}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={shopItems.map((item) => item.id)}
              strategy={rectSortingStrategy}
            >
              {shopItems.length > 0 ? (
                <Grid>
                  {shopItems.map((item) => {
                    const details = detailsById.get(item.id);
                    return (
                      <SortableItem key={item.id} id={item.id}>
                        <Grid.Col span={{ base: 12, md: 3 }}>
                          <Paper withBorder pos="relative" p="sm" radius="lg" h="100%">
                            <Stack gap={6} h="100%" align="center">
                              {details && (
                                <Box
                                  h={90}
                                  w="100%"
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    overflow: 'hidden',
                                  }}
                                >
                                  {details.cosmetic && (
                                    <CosmeticSample cosmetic={details.cosmetic} size="md" />
                                  )}
                                </Box>
                              )}
                              <Text fw="bold" size="sm" ta="center" lineClamp={1}>
                                {item.title}
                              </Text>
                              {details && (
                                <Text size="xs" c="dimmed">
                                  {details.cosmetic
                                    ? getDisplayName(details.cosmetic.type)
                                    : 'Pack'}
                                </Text>
                              )}
                              {details?.cosmetic?.creator && (
                                <UserAvatar
                                  user={details.cosmetic!.creator}
                                  withUsername
                                  size="xs"
                                  linkToProfile
                                />
                              )}
                              <Button
                                onClick={() => onRemoveSelectedItem(item.id)}
                                color="red"
                                variant="filled"
                                radius="xl"
                                mt="auto"
                              >
                                <IconTrash size={15} />
                              </Button>
                            </Stack>
                          </Paper>
                        </Grid.Col>
                      </SortableItem>
                    );
                  })}
                </Grid>
              ) : (
                <Center>
                  <Text size="sm" c="dimmed">
                    You have not selected any items to display in this section.
                  </Text>
                </Center>
              )}
            </SortableContext>
          </DndContext>
        </Paper>
      </Stack>
    </Input.Wrapper>
  );
};

export const InputSectionItems = withController(SectionItemsInput);
