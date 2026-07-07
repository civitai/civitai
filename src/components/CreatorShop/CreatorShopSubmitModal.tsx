import {
  Alert,
  Button,
  Center,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
} from '@mantine/core';
import { Dropzone } from '@mantine/dropzone';
import {
  IconBolt,
  IconCircleCheck,
  IconCircleX,
  IconInfoCircle,
  IconUpload,
  IconWallet,
} from '@tabler/icons-react';
import type { ComponentProps } from 'react';
import { useState } from 'react';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { CosmeticSample } from '~/components/Shop/CosmeticSample';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { useMutateCreatorShop } from '~/components/CreatorShop/creator-shop.util';
import { validateCosmeticImage } from '~/components/CreatorShop/creator-shop.validation';
import { useCFImageUpload } from '~/hooks/useCFImageUpload';
import { constants } from '~/server/common/constants';
import type { AutoCheck, UpdateCreatorShopItemInput } from '~/server/schema/creator-shop.schema';
import {
  COSMETIC_PRICE_FLOOR,
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
} from '~/server/schema/creator-shop.schema';
import { IMAGE_MIME_TYPE } from '~/shared/constants/mime-types';
import {
  CosmeticShopItemStatus,
  CosmeticSource,
  CosmeticType,
  MediaType,
} from '~/shared/utils/prisma/enums';
import { formatBytes, numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification } from '~/utils/notifications';

type PreviewCosmetic = ComponentProps<typeof CosmeticPreview>['cosmetic'];
type SampleCosmetic = ComponentProps<typeof CosmeticSample>['cosmetic'];

const typeOptions = [
  { value: CosmeticType.Badge, label: 'Badge' },
  { value: CosmeticType.ProfileDecoration, label: 'Avatar Frame' },
  { value: CosmeticType.ContentDecoration, label: 'Content Decoration' },
  { value: CosmeticType.ProfileBackground, label: 'Profile Background' },
];

const buildData = (type: CosmeticType, imageId: string, animated: boolean) => {
  if (type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration)
    return { url: imageId, animated };
  if (type === CosmeticType.ProfileBackground) return { url: imageId, type: MediaType.image };
  return { url: imageId };
};

const existingArtUrl = (item?: CreatorShopManageItem) =>
  (item?.cosmetic.data as { url?: string } | null)?.url ?? null;

const editNotice = (status?: CosmeticShopItemStatus) => {
  if (status === CosmeticShopItemStatus.Published)
    return 'Changes are re-reviewed before they go live. The item stays published until approved.';
  if (status === CosmeticShopItemStatus.Rejected)
    return 'Saving resubmits this item for review with your changes.';
  if (status === CosmeticShopItemStatus.PendingReview)
    return 'This item is already in review — your changes update the pending submission.';
  return null;
};

export function CreatorShopSubmitModal({ item }: { item?: CreatorShopManageItem }) {
  const dialog = useDialogContext();
  const isEdit = !!item;
  const { submitItem, updateItem } = useMutateCreatorShop();
  const { uploadToCF, files, resetFiles } = useCFImageUpload();

  const [type, setTypeState] = useState<CosmeticType>(item?.cosmetic.type ?? CosmeticType.Badge);
  const [name, setName] = useState(item?.title ?? '');
  const [description, setDescription] = useState(item?.description ?? '');
  const [price, setPrice] = useState<number>(item?.unitAmount ?? COSMETIC_PRICE_FLOOR);
  const [quantity, setQuantity] = useState<number | undefined>(
    item?.availableQuantity ?? undefined
  );
  const [buzzType, setBuzzType] = useState<'yellow' | 'green'>('yellow');
  const [imageId, setImageId] = useState<string | null>(existingArtUrl(item));
  const [checks, setChecks] = useState<AutoCheck[]>([]);
  const [artReplaced, setArtReplaced] = useState(false);
  const [animated, setAnimated] = useState<boolean>(
    !!(item?.cosmetic.data as { animated?: boolean } | null)?.animated
  );

  // Buyers already own the art once an item is published or sold — lock it.
  const artLocked =
    isEdit && (item?.status === CosmeticShopItemStatus.Published || (item?.purchases ?? 0) > 0);
  const supportsAnimated = type === CosmeticType.Badge || type === CosmeticType.ProfileDecoration;

  const maxSize = constants.mediaUpload.maxImageFileSize;
  const uploading = !!files[0] && files[0].progress < 100;
  const allChecksPassed = checks.length > 0 && checks.every((c) => c.passed);
  // Existing art (edit, not replaced) is trusted; new art must pass its checks.
  const artOk = !!imageId && (isEdit && !artReplaced ? true : allChecksPassed);

  const setType = (next: CosmeticType) => {
    setTypeState(next);
    setImageId(null);
    setChecks([]);
    setArtReplaced(true);
  };

  const handleDrop = async (dropped: File[]) => {
    const file = dropped[0];
    if (!file) return;
    setArtReplaced(true);
    const result = await validateCosmeticImage(file, type, maxSize);
    setChecks(result.checks);
    if (!result.allRequiredPassed) {
      setImageId(null);
      return;
    }
    const uploaded = await uploadToCF(file);
    setImageId(uploaded.id);
  };

  const canSubmit = artOk && !!name.trim() && price >= COSMETIC_PRICE_FLOOR;

  const handleSubmit = async () => {
    if (!canSubmit || !imageId) {
      showErrorNotification({
        title: 'Not ready',
        error: new Error('Add valid artwork, a title, and a price of at least 500 Buzz'),
      });
      return;
    }
    try {
      if (isEdit && item) {
        // Only send fields that actually changed so a published item re-reviews
        // only on a real edit.
        const payload: UpdateCreatorShopItemInput = { id: item.id };
        if (name.trim() !== item.title) payload.name = name.trim();
        if ((description.trim() || null) !== (item.description ?? null))
          payload.description = description.trim() || null;
        if (price !== item.unitAmount) payload.price = price;
        if ((quantity ?? null) !== (item.availableQuantity ?? null))
          payload.availableQuantity = quantity ?? null;
        // The server re-validates and builds the cosmetic data from imageUrl.
        if (artReplaced) {
          payload.imageUrl = imageId;
          payload.animated = animated;
        }
        await updateItem.mutateAsync(payload);
      } else {
        await submitItem.mutateAsync({
          cosmeticType: type,
          name: name.trim(),
          description: description.trim() || null,
          imageUrl: imageId,
          animated,
          price,
          availableQuantity: quantity ?? null,
          buzzType,
        });
      }
      resetFiles();
      dialog.onClose();
    } catch {
      // surfaced by the mutation hook
    }
  };

  const previewCosmetic = {
    id: item?.cosmetic.id ?? 0,
    name: name || 'Preview',
    type,
    source: CosmeticSource.Purchase,
    description: description || null,
    data: imageId ? buildData(type, imageId, animated) : {},
  } as unknown as PreviewCosmetic;

  const earn = Math.floor(price * CREATOR_SHOP_CREATOR_SHARE);
  const notice = isEdit ? editNotice(item?.status) : null;
  const pending = isEdit ? updateItem.isPending : submitItem.isPending;

  return (
    <Modal {...dialog} size="lg" title={isEdit ? 'Edit item' : 'Submit an item'}>
      <Stack>
        <Select
          label="Cosmetic type"
          data={typeOptions}
          value={type}
          onChange={(v) => v && setType(v as CosmeticType)}
          allowDeselect={false}
          withAsterisk
          disabled={isEdit}
          description={isEdit ? 'Type cannot be changed after submission' : undefined}
        />

        <Stack gap={6}>
          <Text size="sm" fw={500}>
            Artwork <span style={{ color: 'var(--mantine-color-red-5)' }}>*</span>
          </Text>
          {artLocked ? (
            <Group>
              <Center
                style={{
                  width: 120,
                  height: 120,
                  background: 'var(--mantine-color-dark-8)',
                  borderRadius: 8,
                }}
              >
                <CosmeticSample cosmetic={previewCosmetic as unknown as SampleCosmetic} size="lg" />
              </Center>
              <Text size="xs" c="dimmed" maw={220}>
                Artwork can&apos;t be changed after an item is published or sold. You can still
                update its title, description, and price.
              </Text>
            </Group>
          ) : imageId ? (
            <Group>
              <Center
                style={{
                  width: 120,
                  height: 120,
                  background: 'var(--mantine-color-dark-8)',
                  borderRadius: 8,
                }}
              >
                <CosmeticSample cosmetic={previewCosmetic as unknown as SampleCosmetic} size="lg" />
              </Center>
              <Button
                variant="subtle"
                color="red"
                onClick={() => {
                  setImageId(null);
                  setChecks([]);
                  setArtReplaced(true);
                  resetFiles();
                }}
              >
                Replace
              </Button>
            </Group>
          ) : (
            <Dropzone
              onDrop={handleDrop}
              accept={IMAGE_MIME_TYPE}
              maxFiles={1}
              maxSize={maxSize}
              loading={uploading}
            >
              <Center mih={120}>
                <Stack align="center" gap={4}>
                  <ThemeIcon variant="light" size="lg" color="gray">
                    <IconUpload size={20} />
                  </ThemeIcon>
                  <Text size="sm">Drag & drop your artwork, or click to browse</Text>
                  <Text size="xs" c="dimmed">
                    PNG with transparency · max {formatBytes(maxSize)}
                  </Text>
                </Stack>
              </Center>
            </Dropzone>
          )}

          {checks.length > 0 && (
            <Paper withBorder radius="md" p="sm">
              <Text size="xs" fw={600} mb={6}>
                Automated checks
              </Text>
              <Stack gap={4}>
                {checks.map((c) => (
                  <Group key={c.key} gap={6} wrap="nowrap">
                    {c.passed ? (
                      <IconCircleCheck size={16} color="var(--mantine-color-green-5)" />
                    ) : (
                      <IconCircleX size={16} color="var(--mantine-color-red-5)" />
                    )}
                    <Text size="xs" c={c.passed ? undefined : 'red'}>
                      {c.label}
                      {c.detail ? ` · ${c.detail}` : ''}
                    </Text>
                  </Group>
                ))}
              </Stack>
              {!allChecksPassed && (
                <Text size="xs" c="red" mt={6}>
                  Fix the failing checks above before you can submit.
                </Text>
              )}
            </Paper>
          )}

          {supportsAnimated && !artLocked && (
            <Switch
              checked={animated}
              onChange={(e) => setAnimated(e.currentTarget.checked)}
              label="Animated cosmetic"
              description="Enable if your artwork is an animated PNG (APNG)."
            />
          )}
        </Stack>

        {artOk && (
          <Stack gap={6}>
            <Divider label="Preview" labelPosition="left" />
            <CosmeticPreview cosmetic={previewCosmetic} />
          </Stack>
        )}

        <TextInput
          label="Title"
          withAsterisk
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="e.g. Golden Laurel Badge"
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => setDescription(e.currentTarget.value)}
          autosize
          minRows={2}
        />

        <Group grow align="flex-end">
          <NumberInput
            label="Price (Buzz)"
            withAsterisk
            min={COSMETIC_PRICE_FLOOR}
            value={price}
            onChange={(v) => setPrice(typeof v === 'number' ? v : COSMETIC_PRICE_FLOOR)}
            leftSection={<IconBolt size={16} />}
          />
          <NumberInput
            label="Quantity (optional)"
            min={1}
            value={quantity}
            onChange={(v) => setQuantity(typeof v === 'number' ? v : undefined)}
            placeholder="Unlimited"
          />
        </Group>
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Minimum {COSMETIC_PRICE_FLOOR} Buzz · You keep{' '}
            {Math.round(CREATOR_SHOP_CREATOR_SHARE * 100)}%
          </Text>
          <Text size="xs" fw={600} c="green">
            You earn ≈ {numberWithCommas(earn)} Buzz per sale
          </Text>
        </Group>

        {!isEdit && (
          <>
            <Group gap="xs" align="center">
              <Text size="sm">Pay fee with</Text>
              <SegmentedControl
                size="xs"
                value={buzzType}
                onChange={(v) => setBuzzType(v as 'yellow' | 'green')}
                data={[
                  { value: 'yellow', label: 'Yellow' },
                  { value: 'green', label: 'Green' },
                ]}
              />
            </Group>
            <Alert color="blue" icon={<IconWallet size={18} />}>
              <Text size="sm" fw={600}>
                {numberWithCommas(CREATOR_SHOP_SUBMISSION_FEE)} Buzz submission fee
              </Text>
              <Text size="xs" c="dimmed">
                Charged when you submit for review. Non-refundable, even if the item isn&apos;t
                approved.
              </Text>
            </Alert>
          </>
        )}

        {notice && (
          <Alert color="yellow" icon={<IconInfoCircle size={18} />}>
            <Text size="xs">{notice}</Text>
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={dialog.onClose}>
            Cancel
          </Button>
          <Button
            leftSection={<IconBolt size={16} />}
            loading={pending}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {isEdit
              ? 'Save changes'
              : `Pay ${numberWithCommas(CREATOR_SHOP_SUBMISSION_FEE)} Buzz & Submit`}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
