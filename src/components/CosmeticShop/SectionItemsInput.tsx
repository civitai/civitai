import type { InputWrapperProps, ComboboxItem } from '@mantine/core';
import { Box, Button, Center, Input, Paper, Select, Stack, Text, Grid } from '@mantine/core';
import React, { forwardRef, useMemo, useState } from 'react';
import { useDebouncedValue, useDidUpdate } from '@mantine/hooks';
import { IconTrash } from '@tabler/icons-react';
import { isEqual } from 'lodash-es';
import type { DragEndEvent } from '@dnd-kit/core';
import { DndContext, PointerSensor, rectIntersection, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove, SortableContext, rectSortingStrategy } from '@dnd-kit/sortable';
import { SortableItem } from '~/components/ImageUpload/SortableItem';
import type { CosmeticShopItemGetById } from '~/types/router';
import { ContentClamp } from '~/components/ContentClamp/ContentClamp';
import { RenderHtml } from '~/components/RenderHtml/RenderHtml';
import { useQueryCosmeticShopItemsPaged } from '~/components/CosmeticShop/cosmetic-shop.util';
import type { GetPaginatedCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
import { isDefined } from '~/utils/type-guards';
import { withController } from '~/libs/form/hoc/withController';

type ShopItemSchema = { title: string; description?: string; id: number };

type SectionItemsInputProps = Omit<InputWrapperProps, 'children' | 'onChange'> & {
  value?: ShopItemSchema[];
  onChange?: (value: ShopItemSchema[]) => void;
};

type CosmeticShopItemSelectItemProps = {
  title: string;
  description?: string | null;
} & ComboboxItem;

const CosmeticShopItemSelectItem = forwardRef<HTMLDivElement, CosmeticShopItemSelectItemProps>(
  ({ title, description, ...others }: CosmeticShopItemSelectItemProps, ref) => (
    <div ref={ref} {...others}>
      <Stack gap={0}>
        <Text size="sm">{title}</Text>
        {description && (
          <ContentClamp maxHeight={200}>
            <RenderHtml html={description} />
          </ContentClamp>
        )}
      </Stack>
    </div>
  )
);

CosmeticShopItemSelectItem.displayName = 'CosmeticShopItemSelectItem';

const CosmeticShopItemSearch = ({
  onItemSelected,
}: {
  onItemSelected: (item: CosmeticShopItemGetById) => void;
}) => {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticShopItemInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { cosmeticShopItems = [], isLoading: isLoadingCosmetics } =
    useQueryCosmeticShopItemsPaged(debouncedFilters);
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
    <Select
      label="Search products by title"
      description="Select items to add to this section"
      onChange={(cosmeticId) => {
        const item = cosmeticShopItems.find((c) => c.id === Number(cosmeticId ?? 0));
        if (item) {
          onItemSelected(item);
        }
      }}
      onSearchChange={(query) => setFilters({ ...filters, name: query })}
      searchValue={filters.name}
      nothingFoundMessage="No options"
      renderOption={(item) => {
        const data = cosmeticShopItems.find((c) => c.id === Number(item.option.value));
        if (!data) {
          return null;
        }

        return <CosmeticShopItemSelectItem {...item.option} {...data} />;
      }}
      data={data}
      searchable
      withAsterisk
      value={''}
    />
  );
};

export const SectionItemsInput = ({ value, onChange, ...props }: SectionItemsInputProps) => {
  const [shopItems, setSelectedShopItems] = useState<ShopItemSchema[]>(value || []);
  const [error, setError] = useState('');

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
                    return (
                      <SortableItem key={item.id} id={item.id}>
                        <Grid.Col span={{ base: 12, md: 3 }}>
                          <Paper withBorder pos="relative" p="sm" radius="lg" h="100%">
                            <Stack gap={0} h="100%">
                              <Text fw="bold" size="md">
                                {item.title}
                              </Text>
                              {item.description && (
                                <ContentClamp maxHeight={50}>
                                  <RenderHtml html={item.description} />
                                </ContentClamp>
                              )}
                              <Box mb="md" />

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
