import { SignalMessages } from '~/server/common/enums';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCallback } from 'react';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { showBuzzNotification } from '~/utils/notifications';
import { Text } from '@mantine/core';

export const SignalNotifications = () => {
  const onBalanceUpdate = useCallback((updated: BuzzUpdateSignalSchema) => {
    const isGenerationAccount = updated.accountType === 'user:generation';

    showBuzzNotification({
      color: isGenerationAccount ? 'blue.4' : 'yellow.7',
      // TODO: Message might need updating as the data in the signal is updated
      message:
        updated.delta > 0 ? (
          <Text>
            <Text weight="bold" span>
              {updated.delta.toLocaleString()} Buzz
            </Text>{' '}
            has been added to your {isGenerationAccount ? 'generation credit' : 'account'}
          </Text>
        ) : (
          <Text>
            <Text weight="bold" span>
              {Math.abs(updated.delta).toLocaleString()} Buzz
            </Text>{' '}
            has been debited from your {isGenerationAccount ? 'generation credit' : 'account'}
          </Text>
        ),
    });
  }, []);

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return null;
};
