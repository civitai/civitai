import { Alert, Group, SegmentedControl, Text } from '@mantine/core';
import { IconWallet } from '@tabler/icons-react';
import { numberWithCommas } from '~/utils/number-helpers';

// Fee-payment account picker (with live balances) and the submission-fee notice,
// which warns when the chosen account can't cover the fee.
export function FeeSection({
  buzzType,
  onBuzzTypeChange,
  yellowBalance,
  greenBalance,
  blueBalance,
  feeAccountBalance,
  canAffordFee,
  submissionFee,
}: {
  buzzType: 'yellow' | 'green' | 'blue';
  onBuzzTypeChange: (value: 'yellow' | 'green' | 'blue') => void;
  yellowBalance: number;
  greenBalance: number;
  blueBalance: number;
  feeAccountBalance: number;
  canAffordFee: boolean;
  submissionFee: number | undefined;
}) {
  return (
    <>
      <Group gap="xs" align="center">
        <Text size="sm">Pay fee with</Text>
        <SegmentedControl
          size="xs"
          value={buzzType}
          onChange={(v) => onBuzzTypeChange(v as 'yellow' | 'green' | 'blue')}
          data={[
            { value: 'yellow', label: `Yellow · ${numberWithCommas(yellowBalance)}` },
            { value: 'green', label: `Green · ${numberWithCommas(greenBalance)}` },
            { value: 'blue', label: `Blue · ${numberWithCommas(blueBalance)}` },
          ]}
        />
      </Group>
      <Alert color={canAffordFee ? 'yellow' : 'red'} icon={<IconWallet size={18} />}>
        <Text size="sm" fw={600}>
          {submissionFee === undefined ? '…' : numberWithCommas(submissionFee)} Buzz submission fee
        </Text>
        <Text size="xs" c="dimmed">
          Charged when you submit for review, and{' '}
          <Text span fw={700} c="dimmed">
            not refunded
          </Text>{' '}
          if your item is rejected. If we ask for changes, you can revise and resubmit at{' '}
          <Text span fw={700} c="dimmed">
            no extra cost
          </Text>
          .
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
