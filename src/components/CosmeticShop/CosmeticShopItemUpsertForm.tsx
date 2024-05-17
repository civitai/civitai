import {
  Button,
  Group,
  Stack,
  Text,
  Tooltip,
  TooltipProps,
  ActionIcon,
  Grid,
  Avatar,
  Modal,
  Divider,
  Center,
  Loader,
  Box,
  Input,
  Select,
  SelectItemProps,
  Paper,
} from '@mantine/core';
import React, { forwardRef, useEffect, useMemo, useState } from 'react';

import {
  Form,
  InputDatePicker,
  InputNumber,
  InputRTE,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import { z } from 'zod';
import { CosmeticGetById, CosmeticShopItemGetById } from '~/types/router';
import { showSuccessNotification } from '~/utils/notifications';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { useQueryCosmetic, useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { useDebouncedValue } from '@mantine/hooks';
import {
  CosmeticShopItemMeta,
  upsertCosmeticShopItemInput,
} from '~/server/schema/cosmetic-shop.schema';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';
import { CosmeticSample } from '~/pages/moderator/cosmetic-store/cosmetics';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { IconCalendar, IconQuestionMark, IconX } from '@tabler/icons-react';
import { IconCalendarDue } from '@tabler/icons-react';
import { isDefined } from '~/utils/type-guards';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';

const formSchema = upsertCosmeticShopItemInput;

type Props = {
  shopItem?: CosmeticShopItemGetById;
  onSuccess?: () => void;
  onCancel?: () => void;
};

type CosmeticSearchSelectItemProps = { name: string; description: string } & SelectItemProps;

const CosmeticSearchSelectItem = forwardRef<HTMLDivElement, CosmeticSearchSelectItemProps>(
  ({ name, description, ...others }: CosmeticSearchSelectItemProps, ref) => (
    <div ref={ref} {...others}>
      <Stack spacing={0}>
        <Text size="sm">{name}</Text>
        <Text size="xs" color="dimmed">
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
  const [debouncedFilters, cancel] = useDebouncedValue(filters, 500);
  const { cosmetics, isLoading: isLoadingCosmetics } = useQueryCosmeticsPaged(debouncedFilters);
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
      onChange={(cosmeticId: string) => onCosmeticSelected(Number(cosmeticId))}
      onSearchChange={(query) => setFilters({ ...filters, name: query })}
      searchValue={filters.name}
      nothingFound="No options"
      itemComponent={CosmeticSearchSelectItem}
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
  const currentUser = useCurrentUser();
  const form = useForm({
    schema: formSchema,
    defaultValues: {
      ...shopItem,
      meta: {
        paidToUserIds: [],
        ...((shopItem?.meta as MixedObject) ?? {}),
      },
      archived: shopItem?.archivedAt !== null,
    },
    shouldUnregister: false,
  });

  const [title, description, cosmeticId, paidToUserIds, availableQuantity] = form.watch([
    'title',
    'description',
    'cosmeticId',
    'meta.paidToUserIds',
    'availableQuantity',
  ]);
  const { cosmetic, isLoading: isLoadingCosmetic } = useQueryCosmetic({ id: cosmeticId });

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
    if (!shopItem && cosmetic && (!title || !description)) {
      // Resource changed, change our data. Fallback to current data if resource data is not available
      form.setValue('title', cosmetic.name || title);
      form.setValue('description', `<p>${cosmetic.description || description || ''}</p>`);
    }
  }, [cosmetic, shopItem]);

  return (
    <Form form={form} onSubmit={handleSubmit}>
      <Stack spacing="md">
        <Stack spacing="md">
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
                <Stack spacing={4}>
                  <Group spacing={4}>
                    <Text inline>Archived</Text>
                  </Group>
                  <Text size="xs" color="dimmed">
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
                <Text color="dimmed" weight="bold">
                  The following cosmetic will be made into a shop product
                </Text>
                <Divider mx="-md" />
                <Group>
                  <CosmeticSample cosmetic={cosmetic} />
                  <Stack spacing={0}>
                    <Text>{cosmetic.name}</Text>
                    <Text color="dimmed" size="sm">
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
          <Group spacing="md" grow>
            <InputNumber
              name="unitAmount"
              label="Price"
              description="The amount of buzz required to purchase 1 instance of this item"
              min={500}
              step={100}
              icon={<CurrencyIcon currency="BUZZ" size={16} />}
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
            <Text color="red" size="sm">
              This item has been purchased {shopItemMeta.purchases} times. Changing the price or
              quantity will not affect existing purchases. And you cannot make the number of
              available items less than the number of purchases.
            </Text>
          )}
          <Group spacing="md" grow>
            <InputDatePicker
              name="availableFrom"
              label="Available From"
              placeholder="Select a start date"
              icon={<IconCalendar size={16} />}
              clearable
            />
            <InputDatePicker
              name="availableTo"
              label="Available To"
              placeholder="Select an end date"
              icon={<IconCalendarDue size={16} />}
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

              <Group mx="auto" position="apart">
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
          <Group position="right">
            {onCancel && (
              <Button
                loading={upsertingShopItem}
                onClick={(e) => {
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
