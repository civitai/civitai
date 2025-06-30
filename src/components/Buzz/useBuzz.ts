import { useCallback } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { BuzzAccountType, GetTransactionsReportSchema } from '~/server/schema/buzz.schema';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { trpc } from '~/utils/trpc';

export const useBuzz = (
  accountId?: number,
  accountType?: BuzzAccountType[] | BuzzAccountType | null
) => {
  const currentUser = useCurrentUser();
  const features = useFeatureFlags();
  const { data, isLoading } = trpc.buzz.getBuzzAccount.useQuery(
    {
      accountId: accountId ?? (currentUser?.id as number),
      accountType: Array.isArray(accountType) ? undefined : accountType,
      accountTypes: Array.isArray(accountType) ? accountType : undefined,
    },
    { enabled: !!currentUser && features.buzz }
  );

  return {
    balanceLoading: isLoading,
    balances: (data ?? []).map((item) => ({
      balance: item.balance,
      lifetimeBalance: item.lifetimeBalance,
      accountType: item.accountType,
    })),
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
          if (!old || !old[0]) return old;
          return [{ ...old[0], balance: updated.balance }];
        }
      );

      queryUtils.buzz.getBuzzAccount.setData(
        { accountId: currentUser.id as number, accountType: null },
        (old) => {
          if (!old || !old[0] || !old[0].balance) return old;
          return [{ ...old[0], balance: (old[0].balance ?? 0) + updated.delta }];
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

export const useBuzzTransactions = (
  accountId?: number,
  accountType?: BuzzAccountType,
  filters?: {
    limit: number;
  }
) => {
  const features = useFeatureFlags();
  const { data: { transactions = [] } = {}, isLoading } = trpc.buzz.getAccountTransactions.useQuery(
    {
      limit: filters?.limit ?? 200,
      accountId: accountId as number,
      accountType,
    },
    { enabled: !!accountId && features.buzz }
  );

  return {
    transactions: transactions ?? [],
    isLoading: accountId ? isLoading : false,
  };
};

export const useTransactionsReport = (
  filters: GetTransactionsReportSchema = {
    window: 'hour',
    accountType: ['User', 'Generation'],
  },
  opts: { enabled: boolean }
) => {
  const {
    data: report = [],
    isLoading,
    ...rest
  } = trpc.buzz.getTransactionsReport.useQuery({ ...(filters ?? {}) }, { enabled: opts.enabled });

  return {
    report: report ?? [],
    isLoading: opts.enabled ? isLoading : false,
    ...rest,
  };
};
