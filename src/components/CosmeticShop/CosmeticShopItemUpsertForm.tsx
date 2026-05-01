import type { ComboboxItem } from '@mantine/core';
import {
  Box,
  Button,
  Divider,
  Group,
  Input,
  Loader,
  LoadingOverlay,
  Paper,
  Select,
  Stack,
  Switch,
  Tabs,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import { useDebouncedValue } from '@mantine/hooks';
import {
  IconCalendar,
  IconCalendarDue,
  IconPhoto,
  IconTrash,
  IconUpload,
  IconX,
} from '@tabler/icons-react';
import React, { forwardRef, useEffect, useMemo, useState } from 'react';
import type * as z from 'zod';
import { EdgeMedia } from '~/components/EdgeMedia/EdgeMedia';
import { useQueryCosmetic, useQueryCosmeticsPaged } from '~/components/Cosmetics/cosmetics.util';
import { useMutateCosmeticShop } from '~/components/CosmeticShop/cosmetic-shop.util';
import { SmartCreatorCard } from '~/components/CreatorCard/CreatorCard';
import { CurrencyIcon } from '~/components/Currency/CurrencyIcon';
import { LegacyActionIcon } from '~/components/LegacyActionIcon/LegacyActionIcon';
import { QuickSearchDropdown } from '~/components/Search/QuickSearchDropdown';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';

import {
  Form,
  InputDatePicker,
  InputNumber,
  InputRTE,
  InputSwitch,
  InputText,
  useForm,
} from '~/libs/form';
import type { CosmeticShopItemMeta } from '~/server/schema/cosmetic-shop.schema';
import { upsertCosmeticShopItemInput } from '~/server/schema/cosmetic-shop.schema';
import type { GetPaginatedCosmeticsInput } from '~/server/schema/cosmetic.schema';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import { CosmeticSource, CosmeticType, MediaType } from '~/shared/utils/prisma/enums';
import type { CosmeticGetById, CosmeticShopItemGetById } from '~/types/router';
import { formatBytes } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
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

const cosmeticTypeOptions: { value: CosmeticType; label: string }[] = [
  { value: CosmeticType.Badge, label: 'Badge' },
  { value: CosmeticType.ProfileDecoration, label: 'Profile Decoration' },
  { value: CosmeticType.ContentDecoration, label: 'Content Decoration' },
  { value: CosmeticType.ProfileBackground, label: 'Profile Background' },
  { value: CosmeticType.NamePlate, label: 'Name Plate' },
];

const cosmeticSourceOptions: { value: CosmeticSource; label: string }[] = [
  { value: CosmeticSource.Purchase, label: 'Purchase' },
  { value: CosmeticSource.Membership, label: 'Membership' },
  { value: CosmeticSource.Trophy, label: 'Trophy' },
  { value: CosmeticSource.Event, label: 'Event' },
  { value: CosmeticSource.Claim, label: 'Claim' },
];

const isImageBasedCosmeticType = (type: CosmeticType) =>
  type === CosmeticType.Badge ||
  type === CosmeticType.ProfileDecoration ||
  type === CosmeticType.ContentDecoration ||
  type === CosmeticType.ProfileBackground;

/**
 * Inline cosmetic creator. Lets a moderator drop in an image and basic
 * metadata, persists a new Cosmetic record, and hands the resulting id back to
 * the parent form so it can finish saving the shop item.
 */
const NewCosmeticInlineCreator = ({ onCreated }: { onCreated: (cosmeticId: number) => void }) => {
  const { upsertCosmetic, upsertingCosmetic } = useMutateCosmeticShop();
  const { uploadToCF, files: imageFiles, resetFiles } = useCFImageUpload();

  const [type, setType] = useState<CosmeticType>(CosmeticType.Badge);
  const [source, setSource] = useState<CosmeticSource>(CosmeticSource.Purchase);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [animated, setAnimated] = useState(false);
  const [imageId, setImageId] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const requiresImage = isImageBasedCosmeticType(type);

  const handleDrop = async (files: File[]) => {
    const [file] = files;
    if (!file) return;

    const maxSize = constants.mediaUpload.maxImageFileSize;
    if (file.size > maxSize) {
      showErrorNotification({
        title: 'File too large',
        error: new Error(`File should not exceed ${formatBytes(maxSize)}`),
      });
      return;
    }

    const result = await uploadToCF(file);
    setImageId(result.id);
    setPreviewUrl(result.objectUrl ?? result.id);
  };

  const handleRemoveImage = () => {
    setImageId(null);
    setPreviewUrl(null);
    resetFiles();
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      showErrorNotification({
        title: 'Missing name',
        error: new Error('Enter a cosmetic name'),
      });
      return;
    }

    if (requiresImage && !imageId) {
      showErrorNotification({
        title: 'Missing image',
        error: new Error('Upload an image for this cosmetic type'),
      });
      return;
    }

    let data: Record<string, unknown> = {};
    if (type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration) {
      data = { url: imageId, animated };
    } else if (type === CosmeticType.ContentDecoration) {
      data = { url: imageId };
    } else if (type === CosmeticType.ProfileBackground) {
      data = { url: imageId, type: MediaType.image };
    }
    // NamePlate gets `data: {}` — moderator can fill styling later via DB tools.

    try {
      const cosmetic = await upsertCosmetic({
        name: name.trim(),
        description: description.trim() || null,
        type,
        source,
        permanentUnlock: false,
        data,
      });

      showSuccessNotification({
        title: 'Cosmetic created',
        message: `"${cosmetic.name}" is ready to be added as a shop product.`,
      });
      onCreated(cosmetic.id);
    } catch {
      // notification surfaced by mutation hook
    }
  };

  const imageFile = imageFiles[0];
  const showLoading = imageFile && imageFile.progress < 100;

  return (
    <Paper withBorder p="md" radius="md">
      <Stack>
        <Text fw="bold">Create a new cosmetic</Text>
        <Text size="xs" c="dimmed">
          The new cosmetic record is created immediately. After it&apos;s created, you&apos;ll
          continue filling in the shop product details below.
        </Text>

        <Group grow>
          <Select
            label="Type"
            data={cosmeticTypeOptions}
            value={type}
            onChange={(value) => value && setType(value as CosmeticType)}
            allowDeselect={false}
            withAsterisk
          />
          <Select
            label="Source"
            data={cosmeticSourceOptions}
            value={source}
            onChange={(value) => value && setSource(value as CosmeticSource)}
            allowDeselect={false}
            withAsterisk
          />
        </Group>

        <TextInput
          label="Name"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="e.g. Founder Badge"
          withAsterisk
        />

        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          placeholder="Optional description shown to users"
          autosize
          minRows={2}
        />

        {requiresImage ? (
          <div>
            <Text fw={500} size="sm" mb={4}>
              Image <span style={{ color: 'var(--mantine-color-red-6)' }}>*</span>
            </Text>
            {showLoading ? (
              <Paper style={{ position: 'relative', width: '100%', height: 150 }} withBorder>
                <LoadingOverlay visible />
              </Paper>
            ) : previewUrl ? (
              <div style={{ position: 'relative', display: 'inline-block' }}>
                <LegacyActionIcon
                  size="sm"
                  variant="filled"
                  color="red"
                  onClick={handleRemoveImage}
                  className="absolute right-1 top-1 z-[1]"
                >
                  <IconTrash size={14} />
                </LegacyActionIcon>
                <Paper withBorder p="sm" radius="md">
                  <EdgeMedia
                    src={previewUrl}
                    type={MediaType.image}
                    width={120}
                    style={{ width: 120, height: 120, objectFit: 'contain' }}
                    anim
                  />
                </Paper>
              </div>
            ) : (
              <Dropzone
                accept={IMAGE_MIME_TYPE}
                onDrop={handleDrop}
                maxFiles={1}
                style={{ maxWidth: 400 }}
              >
                <Dropzone.Accept>
                  <Group justify="center" gap="xs">
                    <IconUpload size={32} stroke={1.5} className="text-blue-6 dark:text-blue-4" />
                    <Text c="dimmed">Drop image here</Text>
                  </Group>
                </Dropzone.Accept>
                <Dropzone.Reject>
                  <Group justify="center" gap="xs">
                    <IconX size={32} stroke={1.5} className="text-red-6 dark:text-red-4" />
                    <Text>File not accepted</Text>
                  </Group>
                </Dropzone.Reject>
                <Dropzone.Idle>
                  <Group justify="center" gap="xs" p="sm">
                    <IconPhoto size={32} stroke={1.5} />
                    <Text c="dimmed">Drop image here or click to browse</Text>
                  </Group>
                </Dropzone.Idle>
              </Dropzone>
            )}
          </div>
        ) : (
          <Text size="sm" c="dimmed">
            Name plates do not have an image — additional styling fields can be added later via the
            existing cosmetics tools.
          </Text>
        )}

        {(type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration) && (
          <Switch
            label="Animated"
            description="Toggle on for animated GIF/APNG sources"
            checked={animated}
            onChange={(e) => setAnimated(e.currentTarget.checked)}
          />
        )}

        <Group justify="flex-end">
          <Button onClick={handleCreate} loading={upsertingCosmetic}>
            Create cosmetic
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
};

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
  const [selectedCosmeticId, setSelectedCosmeticId] = useState<string | null>(
    cosmetic ? cosmetic.id.toString() : null
  );
  const [debouncedFilters] = useDebouncedValue(filters, 500);
  const { cosmetics } = useQueryCosmeticsPaged(debouncedFilters);
  const data = useMemo(
    () =>
      cosmetics.filter(isDefined).map((c) => ({
        value: c.id.toString(),
        label: c.name,
        name: c.name,
        description: c.description,
      })),
    [cosmetics]
  );

  return (
    <Select
      label="Cosmetic"
      description="Select a cosmetic to make into a product. Search by name"
      onChange={(cosmeticId) => {
        onCosmeticSelected(Number(cosmeticId));
        setSelectedCosmeticId(cosmeticId || null);
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
      value={selectedCosmeticId}
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
  const { cosmetic, isInitialLoading, isRefetching } = useQueryCosmetic({ id: cosmeticId });
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
            <Tabs defaultValue="existing">
              <Tabs.List>
                <Tabs.Tab value="existing">Use existing cosmetic</Tabs.Tab>
                <Tabs.Tab value="new">Create new cosmetic</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="existing" pt="sm">
                <CosmeticSearch
                  cosmetic={cosmetic ?? undefined}
                  onCosmeticSelected={(newCosmeticId) => form.setValue('cosmeticId', newCosmeticId)}
                />
              </Tabs.Panel>
              <Tabs.Panel value="new" pt="sm">
                <NewCosmeticInlineCreator
                  onCreated={(newCosmeticId) => form.setValue('cosmeticId', newCosmeticId)}
                />
              </Tabs.Panel>
            </Tabs>
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
          {isInitialLoading || isRefetching ? (
            <Loader />
          ) : cosmetic ? (
            <Paper radius="md" withBorder p="md">
              <Stack>
                <Text c="dimmed" fw="bold">
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
          ) : null}
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
                    <LegacyActionIcon
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
                    </LegacyActionIcon>
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
