import { Alert, Group, SegmentedControl, Text } from '@mantine/core';
import { IconWallet } from '@tabler/icons-react';
import { CREATOR_SHOP_SUBMISSION_FEE } from '~/server/schema/creator-shop.schema';
import { numberWithCommas } from '~/utils/number-helpers';

// Fee-payment account picker (with live balances) and the submission-fee notice,
// which warns when the chosen account can't cover the fee.
export function FeeSection({
  buzzType,
  onBuzzTypeChange,
  yellowBalance,
  greenBalance,
  feeAccountBalance,
  canAffordFee,
}: {
  buzzType: 'yellow' | 'green';
  onBuzzTypeChange: (value: 'yellow' | 'green') => void;
  yellowBalance: number;
  greenBalance: number;
  feeAccountBalance: number;
  canAffordFee: boolean;
}) {
  return (
    <>
      <Group gap="xs" align="center">
        <Text size="sm">Pay fee with</Text>
        <SegmentedControl
          size="xs"
          value={buzzType}
          onChange={(v) => onBuzzTypeChange(v as 'yellow' | 'green')}
          data={[
            { value: 'yellow', label: `Yellow · ${numberWithCommas(yellowBalance)}` },
            { value: 'green', label: `Green · ${numberWithCommas(greenBalance)}` },
          ]}
        />
      </Group>
      <Alert color={canAffordFee ? 'yellow' : 'red'} icon={<IconWallet size={18} />}>
        <Text size="sm" fw={600}>
          {numberWithCommas(CREATOR_SHOP_SUBMISSION_FEE)} Buzz submission fee
        </Text>
        <Text size="xs" c="dimmed">
          Charged when you submit for review.{' '}
          <Text span fw={700} c="dimmed">
            Non-refundable
          </Text>
          , even if the item isn&apos;t approved.
        </Text>
        {!canAffordFee && (
          <Text size="xs" c="red" fw={600} mt={4}>
            Your {buzzType} Buzz balance ({numberWithCommas(feeAccountBalance)}) doesn&apos;t cover
            the fee.
          </Text>
        )}
      </Alert>
    </>
  );
}
