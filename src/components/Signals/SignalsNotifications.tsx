import { Text } from '@mantine/core';
import type { NotificationData } from '@mantine/notifications';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { BuzzSpendType } from '~/server/schema/buzz.schema';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { showBuzzNotification } from '~/utils/notifications';

const baseNotificationConfig: Record<BuzzSpendType, { color: string }> = {
  blue: { color: 'blue.4' },
  green: { color: 'green.7' },
  yellow: { color: 'yellow.7' },
  red: { color: 'red.4' },
};

export const SignalNotifications = () => {
  const onBalanceUpdate = useCallback((updated: BuzzUpdateSignalSchema) => {
    showBuzzNotification({
      ...baseNotificationConfig[updated.accountType],
      title: 'User Buzz Update',
      message:
        updated.delta > 0 ? (
          <Text>
            <Text fw="bold" span>
              {updated.delta.toLocaleString()} Buzz
            </Text>{' '}
            has been added to your Buzz account
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
  }, []);

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return null;
};
