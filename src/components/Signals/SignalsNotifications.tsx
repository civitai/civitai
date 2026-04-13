import { Badge, Text } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { SignalMessages } from '~/server/common/enums';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { showBuzzNotification } from '~/utils/notifications';

const baseNotificationConfig: Record<BuzzSpendType, { color: string }> = {
  blue: { color: 'blue.4' },
  green: { color: 'green.7' },
  yellow: { color: 'yellow.7' },
  red: { color: 'red.4' },
};

export function BonusBadge({ multiplier }: { multiplier: number }) {
  return (
    <Badge
      size="sm"
      radius="xl"
      variant="light"
      color="yellow"
      leftSection={<IconSparkles size={10} />}
      style={{ verticalAlign: 'middle' }}
    >
      {multiplier}x bonus
    </Badge>
  );
}

export const SignalNotifications = () => {
  const { multipliers } = useUserMultipliers();
  const globalBonus = (multipliers as { globalRewardsBonus?: number }).globalRewardsBonus ?? 1;

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      const type = BuzzTypes.toClientType(updated.accountType) as BuzzSpendType;

      // Only show bonus indicator on blue buzz credits (where rewards land)
      const showBonus = updated.delta > 0 && globalBonus > 1 && type === 'blue';

      showBuzzNotification({
        ...baseNotificationConfig[type],
        title: 'User Buzz Update',
        message:
          updated.delta > 0 ? (
            <Text>
              <Text fw="bold" span>
                {updated.delta.toLocaleString()} Buzz
              </Text>{' '}
              has been added to your Buzz account{' '}
              {showBonus && <BonusBadge multiplier={globalBonus} />}
            </Text>
          ) : (
            <Text>
              <Text fw="bold" span>
                {Math.abs(updated.delta).toLocaleString()} Buzz
              </Text>{' '}
              has been debited from your Buzz account
            </Text>
          ),
      });
    },
    [globalBonus]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return null;
};
