import { useCallback, useMemo } from 'react';
import { useSignalConnection } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { SignalMessages } from '~/server/common/enums';
import type { BuzzAccountType, BuzzSpendType } from '~/shared/constants/buzz.constants';
import { BuzzTypes } from '~/shared/constants/buzz.constants';
import type { BuzzUpdateSignalSchema } from '~/server/schema/signals.schema';
import { trpc } from '~/utils/trpc';
import { isDefined } from '~/utils/type-guards';
import type { GetTransactionsReportSchema } from '~/server/schema/buzz.schema';
import { getBuzzTypeDistribution } from '~/utils/buzz';
import { useAvailableBuzz } from './useAvailableBuzz';

export function useQueryBuzz(buzzTypes?: BuzzSpendType[]) {
  const defaultTypes = useAvailableBuzz(buzzTypes);
  const currentUser = useCurrentUser();
  const { data: initialData, isLoading } = trpc.buzz.getBuzzAccount.useQuery(undefined, {
    enabled: !!currentUser,
  });
  const data = useMemo(() => {
    if (!initialData) return { accounts: [], total: 0, nsfwTotal: 0 };
    let total = 0;
    let nsfwTotal = 0;
    const accountTypes = buzzTypes ?? defaultTypes;
    const accounts = accountTypes
      .map((type) => {
        const config = BuzzTypes.getConfig(type);
        if (!config || config.type !== 'spend') return null;
        const balance = initialData[type];
        total += balance;
        if (config.nsfw) nsfwTotal += balance;
        return { ...config, balance, type };
      })
      .filter(isDefined);

    return { accounts, total, nsfwTotal };
  }, [initialData, buzzTypes, defaultTypes]);

  return { data, isLoading };
}

export const useBuzzSignalUpdate = () => {
  const queryUtils = trpc.useUtils();
  const currentUser = useCurrentUser();

  const onBalanceUpdate = useCallback(
    (updated: BuzzUpdateSignalSchema) => {
      if (!currentUser) return;
      const type = BuzzTypes.toClientType(updated.accountType) as BuzzSpendType;
      queryUtils.buzz.getBuzzAccount.setData(undefined, (old) => {
        if (!old) return undefined;
        let balance = old[type];
        if (typeof balance !== 'number') balance = updated.balance;
        else balance += updated.delta;
        return { ...old, [type]: balance };
      });
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
    accountType: 'yellow',
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

export const useMainBuzzAccountType = (
  accountTypes: BuzzSpendType[],
  cost: number
): BuzzSpendType | undefined => {
  const {
    data: { accounts },
  } = useQueryBuzz(accountTypes);

  const buzzTypeDistribution = getBuzzTypeDistribution({
    accounts,
    buzzAmount: cost,
  });
  const baseType = accounts[0]?.type;

  const mainBuzzAccountType = Object.entries(buzzTypeDistribution.amt).reduce(
    (max, [key, amount]) =>
      amount > (buzzTypeDistribution.amt[max as BuzzSpendType] || 0) ? key : max,
    Object.keys(buzzTypeDistribution.amt)[0] || baseType
  ) as BuzzSpendType;

  return mainBuzzAccountType;
};
