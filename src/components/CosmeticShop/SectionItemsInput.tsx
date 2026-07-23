import type { InputWrapperProps } from '@mantine/core';
import {
  Box,
  Button,
  Center,
  Checkbox,
  Group,
  Input,
  Paper,
  Select,
  Stack,
  Text,
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

type ShopItemSchema = { title: string; description?: string; id: number };

// The reseller cut for a sellable-by-others item, undefined otherwise. When
// featured in an official section Civitai acts as the reseller, so the platform
// take is 30% + this share and the creator keeps the rest.
const resaleShare = (meta: unknown) => {
  const m = meta as { sellableByOthers?: boolean; sellerShare?: number } | null;
  return m?.sellableByOthers ? m.sellerShare ?? 0 : undefined;
};

const CutLabel = ({ share }: { share: number }) => (
  <Text size="xs" c="teal" fw={500}>
    Civitai {30 + share}% · creator {70 - share}%
  </Text>
);

type SectionItemsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ShopItemSchema[];
  onChange?: (value: ShopItemSchema[]) => void;
};

const CosmeticShopItemOption = ({ item }: { item: CosmeticShopItemGetById }) => {
  const share = resaleShare(item.meta);
  return (
    <Group gap="sm" wrap="nowrap" w="100%">
      {/* Fixed-width well — profile-background samples render at width 100% and
          would otherwise crush the text column. */}
      <Box w={72} miw={72} style={{ display: 'flex', justifyContent: 'center' }}>
        <CosmeticSample cosmetic={item.cosmetic} size="sm" />
      </Box>
      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={500} lineClamp={1}>
          {item.title}
        </Text>
        <Text size="xs" c="dimmed" lineClamp={1}>
          {getDisplayName(item.cosmetic.type)}
          {item.cosmetic.creator?.username ? ` · by @${item.cosmetic.creator.username}` : ''}
        </Text>
        {share !== undefined && <CutLabel share={share} />}
      </Stack>
    </Group>
  );
};

const CosmeticShopItemSearch = ({
  onItemSelected,
}: {
  onItemSelected: (item: CosmeticShopItemGetById) => void;
}) => {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticShopItemInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { cosmeticShopItems = [], isFetching: isFetchingCosmetics } =
    useQueryCosmeticShopItemsPaged(debouncedFilters);
  // Covers both the in-flight query and the debounce gap after typing.
  const searching = isFetchingCosmetics || !isEqual(filters, debouncedFilters);
  const data = useMemo(
    () =>
      cosmeticShopItems.filter(isDefined).map((c) => ({
        value: c.id.toString(),
        label: c.title,
        title: c.title,
        description: c.description,
      })),
    [cosmeticShopItems]
  );

  return (
    <Stack gap={6}>
      <Select
        label="Search products"
        description="Search by title, cosmetic name, or creator username / id — select items to add to this section"
        onChange={(cosmeticId) => {
          const item = cosmeticShopItems.find((c) => c.id === Number(cosmeticId ?? 0));
          if (item) {
            onItemSelected(item);
          }
        }}
        onSearchChange={(query) => setFilters({ ...filters, name: query })}
        searchValue={filters.name}
        nothingFoundMessage={searching ? 'Searching…' : 'No options'}
        // Options come pre-filtered from the server — Mantine's built-in label
        // filter would hide creator-search matches whose titles don't contain
        // the search term.
        filter={({ options }) => options}
        renderOption={(item) => {
          const data = cosmeticShopItems.find((c) => c.id === Number(item.option.value));
          if (!data) {
            return null;
          }

          return <CosmeticShopItemOption item={data} />;
        }}
        data={data}
        searchable
        withAsterisk
        value={''}
      />
      <Checkbox
        size="xs"
        label="Resellable creator cosmetics only"
        description="Published creator-shop items marked sellable by others — for featuring in official sections."
        checked={!!filters.resellable}
        onChange={(e) =>
          setFilters({ ...filters, resellable: e.currentTarget.checked || undefined })
        }
      />
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
        <CosmeticShopItemSearch onItemSelected={onItemSelected} />
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
                    const share = details ? resaleShare(details.meta) : undefined;
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
                                  <CosmeticSample cosmetic={details.cosmetic} size="md" />
                                </Box>
                              )}
                              <Text fw="bold" size="sm" ta="center" lineClamp={1}>
                                {item.title}
                              </Text>
                              {details && (
                                <Text size="xs" c="dimmed">
                                  {getDisplayName(details.cosmetic.type)}
                                </Text>
                              )}
                              {details?.cosmetic.creator && (
                                <UserAvatar
                                  user={details.cosmetic.creator}
                                  withUsername
                                  size="xs"
                                  linkToProfile
                                />
                              )}
                              {share !== undefined && <CutLabel share={share} />}
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
