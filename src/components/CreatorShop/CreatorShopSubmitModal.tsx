import {
  Alert,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { ArtworkField } from '~/components/CreatorShop/Submit/ArtworkField';
import { FeeSection } from '~/components/CreatorShop/Submit/FeeSection';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import { useSubmitCreatorShopForm } from '~/components/CreatorShop/Submit/useSubmitCreatorShopForm';
import {
  COSMETIC_PRICE_FLOOR,
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
} from '~/server/schema/creator-shop.schema';
import type { CosmeticType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';

export function CreatorShopSubmitModal({ item }: { item?: CreatorShopManageItem }) {
  const dialog = useDialogContext();
  const form = useSubmitCreatorShopForm({ item, onClose: dialog.onClose });
  const {
    isEdit,
    type,
    name,
    description,
    price,
    quantity,
    buzzType,
    animated,
    imageId,
    localUrl,
    checks,
    artLocked,
    supportsAnimated,
    maxSize,
    uploading,
    artOk,
    canAffordFee,
    canSubmit,
    yellowBalance,
    greenBalance,
    feeAccountBalance,
    earn,
    notice,
    pending,
    previewCosmetic,
  } = form;

  return (
    <Modal {...dialog} size="lg" title={isEdit ? 'Edit item' : 'Submit an item'}>
      <Stack>
        <Select
          label="Cosmetic type"
          data={cosmeticTypeOptions}
          value={type}
          onChange={(v) => v && form.setType(v as CosmeticType)}
          allowDeselect={false}
          withAsterisk
          disabled={isEdit}
          description={isEdit ? 'Type cannot be changed after submission' : undefined}
        />

        <ArtworkField
          type={type}
          artLocked={artLocked}
          localUrl={localUrl}
          imageId={imageId}
          uploading={uploading}
          maxSize={maxSize}
          checks={checks}
          onDrop={form.handleDrop}
          onReplace={form.handleReplace}
        />

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
          onChange={(e) => form.setName(e.currentTarget.value)}
          placeholder="e.g. Golden Laurel Badge"
        />
        <Textarea
          label="Description"
          value={description}
          onChange={(e) => form.setDescription(e.currentTarget.value)}
          autosize
          minRows={2}
        />

        {supportsAnimated && !artLocked && (
          <Switch
            checked={animated}
            onChange={(e) => form.setAnimated(e.currentTarget.checked)}
            label="Animated cosmetic"
            description="Enable if your artwork is an animated PNG or WebP."
          />
        )}

        <Group grow align="flex-end">
          <NumberInput
            label="Price (Buzz)"
            withAsterisk
            min={COSMETIC_PRICE_FLOOR}
            value={price}
            onChange={(v) => form.setPrice(typeof v === 'number' ? v : COSMETIC_PRICE_FLOOR)}
            leftSection={<IconBolt size={16} />}
          />
          <NumberInput
            label="Quantity (optional)"
            min={1}
            value={quantity}
            onChange={(v) => form.setQuantity(typeof v === 'number' ? v : undefined)}
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
          <FeeSection
            buzzType={buzzType}
            onBuzzTypeChange={form.setBuzzType}
            yellowBalance={yellowBalance}
            greenBalance={greenBalance}
            feeAccountBalance={feeAccountBalance}
            canAffordFee={canAffordFee}
          />
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
            onClick={form.handleSubmit}
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
