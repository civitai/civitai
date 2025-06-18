import { Text } from '@mantine/core';
import type { NotificationData } from '@mantine/notifications';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { showBuzzNotification } from '~/utils/notifications';

const notificationConfig: Partial<
  Record<BuzzUpdateSignalSchema['accountType'], (data: BuzzUpdateSignalSchema) => NotificationData>
> = {
  generation: (updated) => ({
    color: 'blue.4',
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
  }),
  user: (updated) => ({
    color: 'yellow.7',
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
  }),
};

export const SignalNotifications = () => {
  const onBalanceUpdate = useCallback((updated: BuzzUpdateSignalSchema) => {
    const config = notificationConfig[updated.accountType] || notificationConfig.user;
    if (config) showBuzzNotification(config(updated));
  }, []);

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return null;
};
