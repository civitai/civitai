import { Badge, Text, VisuallyHidden } from '@mantine/core';
import { IconSparkles } from '@tabler/icons-react';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useUserMultipliers } from '~/components/Buzz/useBuzz';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import { BuzzTypes, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { recordBuzzUpdate, useBuzzDeltaStore } from '~/store/buzz-delta.store';
import { showBuzzNotification } from '~/utils/notifications';
import { formatMultiplier } from '~/utils/buzz';

const baseNotificationConfig: Record<BuzzSpendType, { color: string }> = {
  blue: { color: 'blue.4' },
  green: { color: 'green.7' },
  yellow: { color: 'yellow.7' },
  red: { color: 'red.4' },
};

export function BonusBadge({ multiplier }: { multiplier: number }) {
  return (
    <Badge
      component="span"
      size="sm"
      radius="xl"
      variant="light"
      color="yellow"
      leftSection={<IconSparkles size={10} />}
      style={{ verticalAlign: 'middle' }}
    >
      {formatMultiplier(multiplier)} bonus
    </Badge>
  );
}

function BuzzDeltaAnnouncer() {
  const settled = useBuzzDeltaStore((state) => state.settled);
  if (!settled) return <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" />;

  const verb = settled.direction === 'debit' ? 'Spent' : 'Received';
  const transactions = settled.count > 1 ? ` in ${settled.count} transactions` : '';

  return (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
      {/* A fresh node per group: identical text twice in a row is otherwise not announced again. */}
      <span
        key={settled.seq}
      >{`${verb} ${settled.total.toLocaleString()} Buzz${transactions}.`}</span>
    </VisuallyHidden>
  );
}

export const SignalNotifications = () => {
  const { buzzSpendPop } = useFeatureFlags();
  const { multipliers } = useUserMultipliers();
  const globalBonus = multipliers.globalRewardsBonus;

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      if (buzzSpendPop) {
        recordBuzzUpdate(updated);
        return;
      }

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
    [buzzSpendPop, globalBonus]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return buzzSpendPop ? <BuzzDeltaAnnouncer /> : null;
};
