import { SignalMessages } from '~/server/common/enums';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCallback } from 'react';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { showBuzzNotification } from '~/utils/notifications';
import { Text } from '@mantine/core';

export const SignalNotifications = () => {
  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      showBuzzNotification({
        // TODO: Message might need updating as the data in the signal is updated
        message:
          updated.delta > 0 ? (
            <Text>
              <Text weight="bold" span>
                {updated.delta.toLocaleString()} Buzz
              </Text>{' '}
              has been added to your account
            </Text>
          ) : (
            <Text>
              <Text weight="bold" span>
                {Math.abs(updated.delta)} Buzz
              </Text>{' '}
              has been debited from your account
            </Text>
          ),
      });
    },
    [showBuzzNotification]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return null;
};
