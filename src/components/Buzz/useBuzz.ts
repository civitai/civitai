import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';

export const useBuzz = () => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data, isLoading } = trpc.buzz.getUserAccount.useQuery(undefined, {
    enabled: !!currentUser && features.buzz,
  });

  return {
    balanceLoading: isLoading,
    balance: data?.balance ?? 0,
    lifetimeBalance: data?.lifetimeBalance ?? 0,
  };
};

export const useBuzzSignalUpdate = () => {
  const queryUtils = trpc.useContext();

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      queryUtils.buzz.getUserAccount.setData(undefined, (old) => {
        if (!old) return old;
        return { ...old, balance: updated.balance };
      });
    },
    [queryUtils]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);
};
