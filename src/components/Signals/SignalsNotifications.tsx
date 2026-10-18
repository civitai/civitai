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
      {/* A fresh node per group: identical text twice in a row is otherwise not announced again. */}
      <span
        key={settled.seq}
      >{`${verb} ${settled.total.toLocaleString()} Buzz${transactions}.`}</span>
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
