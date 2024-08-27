import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import { BuzzAccountType } from '~/server/schema/buzz.schema';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { trpc } from '~/utils/trpc';

export const useBuzz = (accountId?: number, accountType?: BuzzAccountType) => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data, isLoading } = trpc.buzz.getBuzzAccount.useQuery(
    { accountId: accountId ?? (currentUser?.id as number), accountType: accountType ?? 'user' },
    { enabled: !!currentUser && features.buzz }
  );

  return {
    balanceLoading: isLoading,
    balance: data?.balance ?? 0,
    lifetimeBalance: data?.lifetimeBalance ?? 0,
  };
};

export const useBuzzSignalUpdate = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      if (!currentUser) return;

      queryUtils.buzz.getBuzzAccount.setData(
        { accountId: currentUser.id as number, accountType: updated.accountType },
        (old) => {
          if (!old) return old;
          return { ...old, balance: updated.balance };
        }
      );
    },
    [queryUtils, currentUser]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);
};

export const useUserMultipliers = () => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data = { purchasesMultiplier: 1, rewardsMultiplier: 1 }, isLoading } =
    trpc.buzz.getUserMultipliers.useQuery(undefined, {
      enabled: !!currentUser && features.buzz,
    });

  return {
    multipliersLoading: isLoading,
    multipliers: data,
  };
};
