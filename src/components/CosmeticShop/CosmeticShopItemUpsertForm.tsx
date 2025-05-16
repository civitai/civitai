import {
  ActionIcon,
  Box,
  Button,
  Divider,
  Group,
  Input,
  Paper,
  Select,
  ComboboxItem,
  Stack,
  Text,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { IconCalendar, IconCalendarDue, IconX } from '@tabler/icons-react';
import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { useQueryCosmetic, useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';

import {
  Form,
  InputDatePicker,
  InputNumber,
  InputRTE,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import {
  CosmeticShopItemMeta,
  upsertCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { CosmeticGetById, CosmeticShopItemGetById } from '~/types/router';
import { isDefined } from '~/utils/type-guards';

const formSchema = upsertCosmeticShopItemInput;

type Props = {
  shopItem?: CosmeticShopItemGetById;
  onSuccess?: () => void;
  onCancel?: () => void;
};

type CosmeticSearchComboboxItem = { name: string; description: string | null } & ComboboxItem;

const CosmeticSearchSelectItem = forwardRef<HTMLDivElement, CosmeticSearchComboboxItem>(
  ({ name, description, ...others }: CosmeticSearchComboboxItem, ref) => (
    <div ref={ref} {...others}>
      <Stack gap={0}>
        <Text size="sm">{name}</Text>
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      </Stack>
    </div>
  )
);

CosmeticSearchSelectItem.displayName = 'CosmeticSearchSelectItem';

const CosmeticSearch = ({
  cosmetic,
  onCosmeticSelected,
}: {
  cosmetic?: CosmeticGetById;
  onCosmeticSelected: (id: number) => void;
}) => {
  const [filters, setFilters] = useState<Omit<GetPaginatedCosmeticsInput, 'limit'>>({
    page: 1,
  });
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { cosmetics } = useQueryCosmeticsPaged(debouncedFilters);
  const data = useMemo(
    () =>
      [cosmetic, ...cosmetics].filter(isDefined).map((c) => ({
        value: c.id.toString(),
        label: c.name,
        name: c.name,
        description: c.description,
      })),
    [cosmetics, cosmetic]
  );

  return (
    <Select
      label="Cosmetic"
      description="Select a cosmetic to make into a product. Search by name"
      onChange={(cosmeticId) => {
        onCosmeticSelected(Number(cosmeticId));
      }}
      onSearchChange={(query) => setFilters({ ...filters, name: query })}
      searchValue={filters.name}
      nothingFoundMessage="No options"
      renderOption={(item) => {
        const itemData = data.find((d) => d.value === item.option.value);
        if (!itemData) return null;

        return <CosmeticSearchSelectItem {...item} {...itemData} />;
      }}
      data={data}
      searchable
      withAsterisk
      value={cosmetic?.id.toString() ?? ''}
      clearable
    />
  );
};

export const CosmeticShopItemUpsertForm = ({ shopItem, onSuccess, onCancel }: Props) => {
  const shopItemMeta = (shopItem?.meta ?? {}) as CosmeticShopItemMeta;
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...shopItem,
      meta: {
        paidToUserIds: [],
        ...((shopItem?.meta as MixedObject) ?? {}),
      },
      archived: shopItem?.archivedAt !== null,
      videoUrl: shopItem?.cosmetic?.videoUrl ?? '',
    },
    shouldUnregister: false,
  });

  const [title, description, videoUrl, cosmeticId, paidToUserIds, availableQuantity] = form.watch([
    'title',
    'description',
    'videoUrl',
    'cosmeticId',
    'meta.paidToUserIds',
    'availableQuantity',
  ]);
  const { cosmetic } = useQueryCosmetic({ id: cosmeticId });
  const { upsertShopItem, upsertingShopItem } = useMutateCosmeticShop();

  const handleSubmit = async (data: z.infer<typeof formSchema>) => {
    try {
      await upsertShopItem({
        ...data,
        availableQuantity: data.availableQuantity ?? null, // Ensures we clear it out
        availableFrom: data.availableFrom ?? null, // Ensures we clear it out
        availableTo: data.availableTo ?? null, // Ensures we clear it out
      });

      if (!data.id) {
        form.reset();
      }

      onSuccess?.();
    } catch (error) {
      // Do nothing since the query event will show an error notification
    }
  };

  useEffect(() => {
    if (!shopItem && cosmetic && (!title || !description || !videoUrl)) {
      // Resource changed, change our data. Fallback to current data if resource data is not available
      form.setValue('title', cosmetic.name || title);
      form.setValue('description', `<p>${cosmetic.description || description || ''}</p>`);
      form.setValue('videoUrl', cosmetic.videoUrl || videoUrl || '');
    }
  }, [cosmetic, shopItem]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack gap="md">
        <Stack gap="md">
          {!shopItem && (
            <CosmeticSearch
              cosmetic={cosmetic ?? undefined}
              onCosmeticSelected={(newCosmeticId) => form.setValue('cosmeticId', newCosmeticId)}
            />
          )}
          {shopItem && (
            <InputSwitch
              name="archived"
              label={
                <Stack gap={4}>
                  <Group gap={4}>
                    <Text inline>Archived</Text>
                  </Group>
                  <Text size="xs" c="dimmed">
                    Archive this item. Archived items are not shown in the shop even if they belong
                    in a section.
                  </Text>
                </Stack>
              }
            />
          )}
          {cosmetic && (
            <Paper radius="md" withBorder p="md">
              <Stack>
                <Text c="dimmed" weight="bold">
                  The following cosmetic will be made into a shop product
                </Text>
                <Divider mx="-md" />
                <Group>
                  <CosmeticSample cosmetic={cosmetic} />
                  <Stack gap={0}>
                    <Text>{cosmetic.name}</Text>
                    <Text c="dimmed" size="sm">
                      {cosmetic.description}
                    </Text>
                  </Stack>
                </Group>
              </Stack>
            </Paper>
          )}
          <InputText
            name="title"
            label="Title"
            description="This title will be shown in the shop. It can be different from the cosmetic's original name"
            withAsterisk
          />
          <InputRTE
            name="description"
            description="This description will be shown in the shop"
            label="Content"
            editorSize="xl"
            includeControls={['heading', 'formatting', 'list', 'link', 'media', 'colors']}
            withAsterisk
            stickyToolbar
          />
          <InputText
            name="videoUrl"
            label="Video Tutorial"
            description="The link to the YouTube video that walks through how this cosmetic was made :D"
            placeholder="e.g., https://www.youtube.com/watch?v=dQw4w9WgXcQ"
          />
          <Group gap="md" grow>
            <InputNumber
              name="unitAmount"
              label="Price"
              description="The amount of Buzz required to purchase 1 instance of this item"
              min={500}
              step={100}
              leftSection={<CurrencyIcon currency="BUZZ" size={16} />}
              format={undefined}
              withAsterisk
            />
            <InputNumber
              name="availableQuantity"
              label="Available Quantity"
              description="The amount of this item available for purchase. Leave empty for unlimited"
              clearable
            />
          </Group>
          {shopItemMeta?.purchases > 0 && availableQuantity && (
            <Text c="red" size="sm">
              This item has been purchased {shopItemMeta.purchases} times. Changing the price or
              quantity will not affect existing purchases. And you cannot make the number of
              available items less than the number of purchases.
            </Text>
          )}
          <Group gap="md" grow>
            <InputDatePicker
              name="availableFrom"
              label="Available From"
              placeholder="Select a start date"
              leftSection={<IconCalendar size={16} />}
              clearable
            />
            <InputDatePicker
              name="availableTo"
              label="Available To"
              placeholder="Select an end date"
              leftSection={<IconCalendarDue size={16} />}
              clearable
            />
          </Group>

          <Divider />
          <Input.Wrapper
            label="Funds Distribution"
            description="Add users to distribute funds to when this item is purchased. The cost of this item will be split evenly among the selected users. Leave empty to keep all funds as Civitai."
            descriptionProps={{ mb: 5 }}
          >
            <Stack>
              <QuickSearchDropdown
                startingIndex="users"
                supportedIndexes={['users']}
                onItemSelected={(item) => {
                  form.setValue('meta.paidToUserIds', [...(paidToUserIds || []), item.entityId]);
                }}
                dropdownItemLimit={25}
              />

              <Group mx="auto" justify="space-between">
                {paidToUserIds?.map((userId) => (
                  <Box style={{ position: 'relative' }} key={userId} w={455}>
                    <ActionIcon
                      pos="absolute"
                      top={-5}
                      right={-5}
                      variant="filled"
                      radius="xl"
                      color="red"
                      style={{
                        zIndex: 10,
                      }}
                      onClick={() => {
                        form.setValue(
                          'meta.paidToUserIds',
                          paidToUserIds.filter((id) => id !== userId)
                        );
                      }}
                    >
                      <IconX size={16} />
                    </ActionIcon>
                    <SmartCreatorCard user={{ id: userId }} />
                  </Box>
                ))}
              </Group>
            </Stack>
          </Input.Wrapper>
        </Stack>
        <Stack>
          <Group justify="flex-end">
            {onCancel && (
              <Button
                loading={upsertingShopItem}
                onClick={(e: React.MouseEvent) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onCancel?.();
                }}
                color="gray"
              >
                Cancel
              </Button>
            )}
            <Button loading={upsertingShopItem} type="submit">
              Save
            </Button>
          </Group>
        </Stack>
      </Stack>
    </Form>
  );
};
