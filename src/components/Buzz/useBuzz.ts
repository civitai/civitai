import { trpc } from '~/utils/trpc';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { SignalMessages } from '~/server/common/enums';
import { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { BuzzAccountType } from '~/server/schema/buzz.schema';
import { useSession } from 'next-auth/react';

export const useBuzz = (accountId?: number, accountType?: BuzzAccountType) => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data, isLoading } = trpc.buzz.getBuzzAccount.useQuery(
    {
      accountId: accountId ?? (currentUser?.id as number),
      accountType: accountType ?? 'User',
    },
    {
      enabled: !!currentUser && features.buzz,
    }
  );

  return {
    balanceLoading: isLoading,
    balance: data?.balance ?? 0,
    lifetimeBalance: data?.lifetimeBalance ?? 0,
  };
};

export const useBuzzSignalUpdate = () => {
  const queryUtils = trpc.useContext();
  const { data: session } = useSession();

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      if (!session?.user) return;

      return queryUtils.buzz.getBuzzAccount.setData(
        {
          accountId: session.user.id as number,
          accountType: 'User',
        },
        (old) => {
          if (!old) return old;
          return { ...old, balance: updated.balance };
        }
      );
    },
    [queryUtils, session]
  );

  useSignalConnection(SignalMessages.BuzzUpdate, onBalanceUpdate);
};

export const useUserMultipliers = () => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data = {}, isLoading } = trpc.buzz.getUserMultipliers.useQuery(undefined, {
    enabled: !!currentUser && features.buzz,
  });

  return {
    multipliersLoading: isLoading,
    multipliers: data,
  };
};
