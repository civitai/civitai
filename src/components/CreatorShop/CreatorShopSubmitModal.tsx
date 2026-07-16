import {
  Alert,
  Button,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconBolt, IconInfoCircle } from '@tabler/icons-react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
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
  computeCreatorShopSplit,
} from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus, type CosmeticType } from '~/shared/utils/prisma/enums';
import { numberWithCommas } from '~/utils/number-helpers';

export function CreatorShopSubmitModal({ item }: { item?: CreatorShopManageItem }) {
  const dialog = useDialogContext();
  const form = useSubmitCreatorShopForm({ item, onClose: dialog.onClose });
  // A live item may already have buyers — only price & quantity may change.
  const contentLocked = item?.status === CosmeticShopItemStatus.Published;
  const {
    isEdit,
    type,
    name,
    description,
    price,
    quantity,
    buzzType,
    animated,
    sellableByOthers,
    sellerShare,
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

  // Resale payout breakdown at the current price (mirrors the server split).
  const {
    sellerAmount: resaleSellerAmount,
    creatorAmount: resaleCreatorAmount,
    platformCut: resalePlatformCut,
  } = computeCreatorShopSplit(price, sellerShare);

  // Dirty = the creator has entered something worth confirming before discarding.
  const isDirty = isEdit
    ? name !== (item?.title ?? '') ||
      description !== (item?.description ?? '') ||
      price !== (item?.unitAmount ?? COSMETIC_PRICE_FLOOR) ||
      !!localUrl
    : !!imageId || !!name.trim() || !!description.trim() || sellableByOthers;

  const handleCancel = () => {
    if (!isDirty) return dialog.onClose();
    dialogStore.trigger({
      component: ConfirmDialog,
      props: {
        title: 'Discard changes?',
        message: isEdit
          ? 'Your changes to this item will be lost.'
          : 'Your uploaded artwork and details will be lost.',
        labels: { cancel: 'Keep editing', confirm: 'Discard' },
        confirmProps: { color: 'red' },
        onConfirm: () => dialog.onClose(),
      },
    });
  };

  return (
    <Modal {...dialog} size="lg" title={isEdit ? 'Edit item' : 'Submit an item'}>
      <Stack>
        {contentLocked ? (
          <>
            <Text fw={600}>{name}</Text>
            {artOk && (
              <Stack gap={6}>
                <Divider label="Preview" labelPosition="left" />
                <CosmeticPreview cosmetic={previewCosmetic} />
              </Stack>
            )}
            <Alert color="blue" icon={<IconInfoCircle size={18} />}>
              <Text size="xs">This item is live — you can only change its price and quantity.</Text>
            </Alert>
          </>
        ) : (
          <>
            <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
              <Text size="xs">
                All cosmetics must be <b>safe-for-work</b> and must not use{' '}
                <b>copyrighted or trademarked material</b> you don&apos;t own. Submissions that
                violate this will be rejected.
              </Text>
            </Alert>
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
          </>
        )}

        <Group grow align="flex-end">
          <NumberInput
            label="Sell price"
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
          <Stack gap={6}>
            <Switch
              checked={sellableByOthers}
              onChange={(e) => form.setSellableByOthers(e.currentTarget.checked)}
              label="Let other creators sell this"
              description="Other creators can list this cosmetic in their own shops."
            />
            {sellableByOthers && (
              <>
                <NumberInput
                  label="Reseller's cut"
                  min={0}
                  max={70}
                  suffix="%"
                  value={sellerShare}
                  onChange={(v) =>
                    form.setSellerShare(typeof v === 'number' ? Math.min(70, Math.max(0, v)) : 0)
                  }
                  description="The % of each resale the seller keeps (they set their own price)."
                />
                <Paper withBorder radius="md" p="sm">
                  <Text size="xs" c="dimmed" mb={4}>
                    Example — a {numberWithCommas(price)} Buzz resale splits into:
                  </Text>
                  <Group justify="space-between">
                    <Text size="xs">Reseller earns</Text>
                    <Text size="xs" fw={600}>
                      {numberWithCommas(resaleSellerAmount)} Buzz · {sellerShare}%
                    </Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="xs">You earn</Text>
                    <Text size="xs" fw={600} c="green">
                      {numberWithCommas(resaleCreatorAmount)} Buzz · {70 - sellerShare}%
                    </Text>
                  </Group>
                  <Group justify="space-between">
                    <Text size="xs" c="dimmed">
                      Civitai
                    </Text>
                    <Text size="xs" c="dimmed">
                      {numberWithCommas(resalePlatformCut)} Buzz · 30%
                    </Text>
                  </Group>
                </Paper>
              </>
            )}
          </Stack>
        )}

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

        <Group justify="space-between">
          <Button variant="default" onClick={handleCancel}>
            Cancel
          </Button>
          {isEdit ? (
            <Button loading={pending} disabled={!canSubmit} onClick={form.handleSubmit}>
              Save changes
            </Button>
          ) : (
            <BuzzTransactionButton
              buzzAmount={CREATOR_SHOP_SUBMISSION_FEE}
              accountTypes={[buzzType]}
              colorType={buzzType}
              label="Submit for review"
              loading={pending}
              disabled={!canSubmit}
              onPerformTransaction={form.handleSubmit}
              showPurchaseModal
            />
          )}
        </Group>
      </Stack>
    </Modal>
  );
}
