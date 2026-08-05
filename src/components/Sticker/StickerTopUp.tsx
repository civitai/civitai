import { Button, Group, NumberInput, Stack, Text } from '@mantine/core';
import { useState } from 'react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { EdgeImage } from '~/components/EdgeMedia/EdgeImage';
import type { ResolvedSticker } from '~/components/Sticker/sticker.util';
import { STICKER_TOPUP_MAX_QUANTITY } from '~/shared/utils/sticker-token';
import { numberWithCommas } from '~/utils/number-helpers';
import { showErrorNotification, showSuccessNotification } from '~/utils/notifications';
import { trpc } from '~/utils/trpc';

const DEFAULT_QUANTITY = 10;

/**
 * Buying more uses where the author ran out, rather than sending them to the
 * shop. The friction this removes is the point of per-use pricing: a composer
 * they have to leave is a comment they don't post.
 */
export function StickerTopUp({
  sticker,
  onCancel,
  onPurchased,
}: {
  sticker: ResolvedSticker;
  onCancel: () => void;
  onPurchased?: () => void;
}) {
  const [quantity, setQuantity] = useState(DEFAULT_QUANTITY);
  const queryUtils = trpc.useUtils();
  const purchase = trpc.cosmetic.purchaseStickerUses.useMutation({
    onSuccess: async (result) => {
      showSuccessNotification({
        title: 'Uses added',
        message: `Added ${numberWithCommas(result.quantity)} uses of :${sticker.slug}:`,
      });
      await Promise.all([
        queryUtils.cosmetic.getStickerBalances.invalidate(),
        queryUtils.user.getCosmetics.invalidate(),
      ]);
      onPurchased?.();
    },
    onError: (error) =>
      showErrorNotification({ title: 'Could not buy uses', error: new Error(error.message) }),
  });

  // A sticker sold before per-use pricing existed has no top-up price, and the
  // listing price is not a stand-in for one.
  if (!sticker.pricePerUse)
    return (
      <Stack gap="xs">
        <Text size="xs" c="dimmed">
          You&apos;re out of uses for :{sticker.slug}:, and this sticker doesn&apos;t sell extra
          uses. You can buy it again in the shop.
        </Text>
        <Button size="xs" variant="default" onClick={onCancel}>
          Back
        </Button>
      </Stack>
    );

  const total = sticker.pricePerUse * quantity;

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="nowrap">
        <EdgeImage
          src={sticker.url}
          options={{ width: 64, anim: sticker.animated }}
          style={{ width: 32, height: 32, objectFit: 'contain' }}
        />
        <div className="flex flex-col">
          <Text size="sm" fw={500} lineClamp={1}>
            :{sticker.slug}:
          </Text>
          <Text size="xs" c="dimmed">
            Out of uses · {numberWithCommas(sticker.pricePerUse)} Buzz each
          </Text>
        </div>
      </Group>
      <NumberInput
        size="xs"
        label="Uses to buy"
        value={quantity}
        onChange={(value) => setQuantity(typeof value === 'number' ? value : DEFAULT_QUANTITY)}
        min={1}
        max={STICKER_TOPUP_MAX_QUANTITY}
        step={10}
      />
      <BuzzTransactionButton
        size="xs"
        buzzAmount={total}
        label="Buy uses"
        loading={purchase.isPending}
        onPerformTransaction={() =>
          purchase.mutate({
            cosmeticId: sticker.id,
            quantity,
            // What the button above is charging for. The server refuses if the
            // creator has moved the price since this rendered.
            expectedPricePerUse: sticker.pricePerUse,
            payWith: 'default',
          })
        }
      />
      <Button size="xs" variant="subtle" color="gray" onClick={onCancel}>
        Cancel
      </Button>
    </Stack>
  );
}
