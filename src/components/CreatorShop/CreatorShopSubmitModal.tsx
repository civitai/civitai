import {
  Alert,
  Anchor,
  Button,
  Divider,
  Group,
  Loader,
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
import { IconAlertTriangle, IconBolt, IconCheck, IconInfoCircle } from '@tabler/icons-react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { InfoPopover } from '~/components/InfoPopover/InfoPopover';
import { CosmeticPreview } from '~/components/CosmeticShop/CosmeticPreview';
import ConfirmDialog from '~/components/Dialog/Common/ConfirmDialog';
import { dialogStore } from '~/components/Dialog/dialogStore';
import { useDialogContext } from '~/components/Dialog/DialogProvider';
import type { CreatorShopManageItem } from '~/components/CreatorShop/creator-shop.util';
import { ArtworkField } from '~/components/CreatorShop/Submit/ArtworkField';
import { CosmeticStudioCallout } from '~/components/CreatorShop/Submit/CosmeticStudioCallout';
import { FeeSection } from '~/components/CreatorShop/Submit/FeeSection';
import { CosmeticStandardsModal } from '~/components/CreatorShop/CosmeticStandardsModal';
import { cosmeticTypeOptions } from '~/components/CreatorShop/Submit/submit.constants';
import { useSubmitCreatorShopForm } from '~/components/CreatorShop/Submit/useSubmitCreatorShopForm';
import {
  CREATOR_SHOP_CREATOR_SHARE,
  CREATOR_SHOP_SUBMISSION_FEE,
  DECORATION_OFFSET_LIMIT,
  computeCreatorShopSplit,
  isCreatorCosmeticType,
} from '~/server/schema/creator-shop.schema';
import { CosmeticShopItemStatus, CosmeticType } from '~/shared/utils/prisma/enums';
import { CREATOR_GRANT_USES_MULTIPLIER, stickerSurfaceLabels } from '~/shared/utils/sticker-token';
import { numberWithCommas } from '~/utils/number-helpers';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

const stickerSurfaces = stickerSurfaceLabels();
const joinLabels = (labels: string[]) =>
  labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : labels[0];

export function CreatorShopSubmitModal({ item }: { item?: CreatorShopManageItem }) {
  const dialog = useDialogContext();
  const form = useSubmitCreatorShopForm({ item, onClose: dialog.onClose });
  // A live item may already have buyers — only price & quantity may change.
  const contentLocked = item?.status === CosmeticShopItemStatus.Published;
  const {
    isEdit,
    type,
    isSticker,
    slug,
    setSlug,
    slugError,
    slugLocked,
    slugStatus,
    priceFloor,
    uses,
    setUses,
    usesError,
    pricePerUse,
    setPricePerUse,
    pricePerUseError,
    perUseFloor,
    name,
    description,
    price,
    quantity,
    buzzType,
    animated,
    sellableByOthers,
    sellerShare,
    acceptsBlueBuzz,
    offsets,
    offsetsChanged,
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
    blueBalance,
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
      price !== (item?.unitAmount ?? priceFloor) ||
      offsetsChanged ||
      form.acceptsBlueBuzzChanged ||
      !!localUrl
    : !!imageId ||
      !!name.trim() ||
      !!description.trim() ||
      sellableByOthers ||
      acceptsBlueBuzz ||
      offsetsChanged;

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

  const features = useFeatureFlags();
  // Mirrors the server gate: no point offering a type the submit will reject.
  const typeOptions = features.stickers
    ? cosmeticTypeOptions
    : cosmeticTypeOptions.filter((o) => o.value !== CosmeticType.Sticker);

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
                <b>copyrighted or trademarked material</b>
                {" you don't own."} Submissions that violate this will be rejected. Review the{' '}
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  fw={600}
                  onClick={() => dialogStore.trigger({ component: CosmeticStandardsModal })}
                >
                  cosmetic quality standards
                </Anchor>{' '}
                before submitting.
              </Text>
            </Alert>
            <Select
              label="Cosmetic type"
              data={typeOptions}
              value={type}
              onChange={(v) => {
                const next = v as CosmeticType | null;
                if (next && isCreatorCosmeticType(next)) form.setType(next);
              }}
              allowDeselect={false}
              withAsterisk
              disabled={isEdit}
              description={isEdit ? 'Type cannot be changed after submission' : undefined}
            />

            {isSticker && (
              <TextInput
                label="Slug"
                placeholder="party_cat"
                value={slug}
                onChange={(e) => setSlug(e.currentTarget.value.toLowerCase())}
                error={slugError ?? (slugStatus === 'taken' ? 'That slug is taken' : undefined)}
                disabled={slugLocked}
                rightSection={
                  slugStatus === 'checking' ? (
                    <Loader size="xs" />
                  ) : slugStatus === 'available' ? (
                    <IconCheck size={16} className="text-green-6" />
                  ) : null
                }
                description={
                  slugLocked
                    ? 'Locked once published — owners already type this to use your sticker'
                    : 'What people type between colons to use your sticker, e.g. :party_cat:'
                }
                withAsterisk
              />
            )}

            {isSticker && (
              <NumberInput
                label={
                  <Group gap={4} wrap="nowrap">
                    <span>Uses per purchase</span>
                    <InfoPopover size="xs" withArrow iconProps={{ size: 14 }}>
                      <Text size="xs">
                        A use is spent when a buyer places your sticker in{' '}
                        {joinLabels(stickerSurfaces.charged)}. Using it in{' '}
                        {joinLabels(stickerSurfaces.free)} is free and unlimited. Once a buyer runs
                        out they can top up at the price you set below.
                      </Text>
                    </InfoPopover>
                  </Group>
                }
                description={
                  uses
                    ? `How many times a buyer can place this sticker. You'll receive ${numberWithCommas(
                        uses * CREATOR_GRANT_USES_MULTIPLIER
                      )} uses of your own once it's approved.`
                    : `How many times a buyer can place this sticker. You'll receive ${CREATOR_GRANT_USES_MULTIPLIER}x that many of your own once it's approved.`
                }
                placeholder="e.g. 100"
                // Empty rather than defaulted: a prefilled number is
                // indistinguishable from a chosen one, and this field decides
                // what every buyer gets.
                value={uses ?? ''}
                onChange={(v) => setUses(typeof v === 'number' ? v : undefined)}
                min={1}
                step={10}
                error={usesError}
                withAsterisk
              />
            )}

            {isSticker && (
              <NumberInput
                label={
                  <Group gap={4} wrap="nowrap">
                    <span>Price per extra use</span>
                    <InfoPopover size="xs" withArrow iconProps={{ size: 14 }}>
                      <Text size="xs">
                        What one more use costs a buyer who has run out. They&apos;re offered it
                        where they run out rather than being sent back to the shop, and you keep the
                        same share as a sale.
                      </Text>
                    </InfoPopover>
                  </Group>
                }
                description={`At least ${perUseFloor} Buzz. This price belongs to the sticker, so it's the same wherever it was bought.`}
                placeholder={`e.g. ${perUseFloor}`}
                value={pricePerUse ?? ''}
                onChange={(v) => setPricePerUse(typeof v === 'number' ? v : undefined)}
                min={perUseFloor}
                step={5}
                error={pricePerUseError}
                withAsterisk
              />
            )}

            {!artLocked && !localUrl && !imageId && <CosmeticStudioCallout />}

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

            {type === CosmeticType.ProfileDecoration && artOk && (
              <Stack gap={6}>
                <Divider label="Adjust fit" labelPosition="left" />
                <Text size="xs" c="dimmed">
                  Nudge each edge of your frame by up to {DECORATION_OFFSET_LIMIT}px to fit the
                  avatar. Negative values extend it outside the avatar (bigger); positive values
                  pull it in. The preview above updates live.
                </Text>
                <Group grow>
                  {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
                    <NumberInput
                      key={side}
                      label={side.charAt(0).toUpperCase() + side.slice(1)}
                      min={-DECORATION_OFFSET_LIMIT}
                      max={DECORATION_OFFSET_LIMIT}
                      step={1}
                      allowDecimal={false}
                      suffix="px"
                      value={offsets[side]}
                      onChange={(v) =>
                        form.setOffset(
                          side,
                          typeof v === 'number'
                            ? Math.max(
                                -DECORATION_OFFSET_LIMIT,
                                Math.min(DECORATION_OFFSET_LIMIT, Math.round(v))
                              )
                            : 0
                        )
                      }
                    />
                  ))}
                </Group>
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

            {supportsAnimated && !artLocked && animated && (
              <Alert color="blue" icon={<IconInfoCircle size={18} />}>
                <Text size="xs">
                  Animated artwork detected — this cosmetic will play its animation.
                </Text>
              </Alert>
            )}
          </>
        )}

        <Group grow align="flex-end">
          <NumberInput
            label="Sell price"
            withAsterisk
            min={priceFloor}
            value={price}
            onChange={(v) => form.setPrice(typeof v === 'number' ? v : priceFloor)}
            leftSection={<IconBolt size={16} />}
          />
          <NumberInput
            label={
              <Group gap={4} wrap="nowrap">
                <span>Quantity (optional)</span>
                <InfoPopover size="xs" withArrow iconProps={{ size: 14 }}>
                  <Text size="xs">
                    The most that will ever be sold. Once it sells out the item is gone for good,
                    which makes it more exclusive for the people who bought one. Leave it empty to
                    keep selling without a limit.
                  </Text>
                </InfoPopover>
              </Group>
            }
            min={1}
            value={quantity}
            onChange={(v) => form.setQuantity(typeof v === 'number' ? v : undefined)}
            placeholder="Unlimited"
          />
        </Group>
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            Minimum {priceFloor} Buzz · You keep {Math.round(CREATOR_SHOP_CREATOR_SHARE * 100)}%
          </Text>
          <Text size="xs" fw={600} c="green">
            You earn ≈ {numberWithCommas(earn)} Buzz per sale
          </Text>
        </Group>

        <Switch
          checked={acceptsBlueBuzz}
          onChange={(e) => form.setAcceptsBlueBuzz(e.currentTarget.checked)}
          label="Accept Blue Buzz"
          description="Buyers can pay with Blue Buzz — fully, or combined with their regular Buzz. You're paid blue for the blue-paid portion."
        />
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
                  description="The % of each resale the seller earns. Resales use your price and inventory."
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
            blueBalance={blueBalance}
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
