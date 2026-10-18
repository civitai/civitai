import { VisuallyHidden } from '@mantine/core';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { recordBuzzUpdate, useBuzzDeltaStore } from '~/store/buzz-delta.store';

function BuzzDeltaAnnouncer() {
  const settled = useBuzzDeltaStore((state) => state.settled);
  if (!settled) return <VisuallyHidden role="status" aria-live="polite" aria-atomic="true" />;

  const verb = settled.direction === 'debit' ? 'Spent' : 'Received';
  const transactions = settled.count > 1 ? ` in ${settled.count} transactions` : '';

  return (
    <VisuallyHidden role="status" aria-live="polite" aria-atomic="true">
      {`${verb} ${settled.total.toLocaleString()} Buzz${transactions}.`}
    </VisuallyHidden>
  );
}

export const SignalNotifications = () => {
  const onBalanceUpdate = useCallback((updated: BuzzUpdateSignalSchema) => {
    recordBuzzUpdate(updated);
  }, []);

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);

  return <BuzzDeltaAnnouncer />;
};
