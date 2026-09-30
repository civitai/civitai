import { Group, SegmentedControl, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { BuzzTransactionButton } from '~/components/Buzz/BuzzTransactionButton';
import { useAvailableBuzz } from '~/components/Buzz/useAvailableBuzz';
import type { PromotionRunDays } from '~/shared/utils/promotion';
import { promotionAmount, PROMOTION_RUN_DAYS } from '~/shared/utils/promotion';

export const PROMOTION_CHECKOUT_TERMS =
  "Once the page owner accepts, your Buzz is theirs, and they can't end your promotion early. Promotions are not refunded if moderation removes them, or if you change or remove what you promoted.";

/** Run length, total, the money terms and the buy button, shared by both promotion modals. */
export function PromotionCheckout({
  quote,
  days,
  onDaysChange,
  disabled,
  loading,
  onBuy,
}: {
  quote: { dailyPrice: number; declineFees: Record<PromotionRunDays, number> } | null;
  days: PromotionRunDays;
  onDaysChange: (days: PromotionRunDays) => void;
  disabled?: boolean;
  loading?: boolean;
  onBuy: (expectedPrice: number) => void;
}) {
  const spendTypes = useAvailableBuzz();
  const total = quote ? promotionAmount(quote.dailyPrice, days) : 0;

  return (
    <Stack gap="sm">
      <Group justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500}>
          Run for
        </Text>
        <SegmentedControl
          value={String(days)}
          onChange={(value) => onDaysChange(Number(value) as PromotionRunDays)}
          data={PROMOTION_RUN_DAYS.map((option) => ({
            value: String(option),
            label: option === 1 ? '1 day' : `${option} days`,
          }))}
        />
      </Group>

      {quote && (
        <Text size="sm" c="dimmed">
          {quote.dailyPrice} Buzz a day, {total} Buzz in total. The run starts when the page owner
          accepts. If they decline, they keep {quote.declineFees[days]} Buzz and the rest comes
          back.
        </Text>
      )}

      <Group gap="xs" wrap="nowrap" align="flex-start">
        <IconAlertTriangle
          size={14}
          className="text-yellow-500"
          style={{ flexShrink: 0, marginTop: 2 }}
        />
        <Text size="xs" c="dimmed">
          {PROMOTION_CHECKOUT_TERMS}
        </Text>
      </Group>

      <Group justify="flex-end">
        <BuzzTransactionButton
          buzzAmount={total}
          accountTypes={spendTypes}
          label="Promote"
          disabled={disabled || !quote}
          loading={loading}
          // The daily price this render showed travels with the purchase, so the
          // server refuses rather than charging a number the buyer never saw.
          onPerformTransaction={() => quote && onBuy(quote.dailyPrice)}
        />
      </Group>
    </Stack>
  );
}
