import dayjs from '~/shared/utils/dayjs';
import { useMemo, useState } from 'react';
import { useSignalConnection, useSignalTopic } from '~/components/Signals/SignalsProvider';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import type { BankBuzzInput, WithdrawCashInput } from '~/server/schema/creator-program.schema';
import type { CompensationPool } from '~/types/router';
import { handleTRPCError, trpc } from '~/utils/trpc';

export const useCreatorProgramRequirements = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.creatorProgram.getCreatorRequirements.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    requirements: data,
    isLoading,
  };
};

export const useCompensationPool = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.creatorProgram.getCompensationPool.useQuery(
    {},
    { enabled: !!currentUser }
  );

  return {
    compensationPool: data,
    isLoading,
  };
};

export const usePrevMonthStats = () => {
  const { data, isLoading } = trpc.creatorProgram.getPrevMonthStats.useQuery();

  return {
    prevMonthStats: data,
    isLoading,
  };
};

export const useBankedBuzz = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.creatorProgram.getBanked.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    banked: data,
    // No loading without a user.
    isLoading: isLoading && currentUser,
  };
};

export const useUserCash = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.creatorProgram.getCash.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    userCash: data,
    isLoading,
  };
};

export const useWithdrawalHistory = () => {
  const currentUser = useCurrentUser();
  const { data, isLoading } = trpc.creatorProgram.getWithdrawalHistory.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    withdrawalHistory: data,
    isLoading,
  };
};

export const useCreatorProgramPhase = () => {
  const { compensationPool, isLoading } = useCompensationPool();

  const phase = useMemo(() => {
    const now = dayjs.utc().toDate();
    if (!compensationPool) {
      return undefined;
    }

    const phase = Object.keys(compensationPool.phases ?? []).find((phase) => {
      const [start, end] =
        compensationPool?.phases[phase as keyof (typeof compensationPool)['phases']];

      return dayjs.utc(start).toDate() <= now && now <= dayjs.utc(end).toDate();
    }) as keyof (typeof compensationPool)['phases'];

    return phase; //
  }, [compensationPool, isLoading]);

  return {
    phase,
    isLoading,
  };
};

export const useCreatorProgramForecast = ({
  bankPortion: initialBankPortion,
  creatorBankPortion: initalCreatorBankPortion,
  buzz,
}: {
  bankPortion?: number;
  creatorBankPortion?: number;
  buzz?: number;
} = {}) => {
  const currentUser = useCurrentUser();
  const [bankPortion, setBankPortion] = useState<number>(initialBankPortion ?? 50);
  const [creatorBankPortion, setCreatorBankPortion] = useState<number>(
    initalCreatorBankPortion ?? 100
  );

  const { data: potential, isLoading } = trpc.buzz.getPoolForecast.useQuery(
    { username: currentUser?.username as string },
    { enabled: !!currentUser }
  );
  const poolValue = potential?.poolValue ?? 0;
  const poolSize = potential?.poolSize ?? 0;
  const earned = buzz ?? potential?.earned ?? 0;

  const bankedBuzz = (poolSize * bankPortion) / 100;
  const creatorBankedBuzz = (earned * creatorBankPortion) / 100;
  const rewardRate = Math.min(poolValue / bankedBuzz, 1 / 1000);
  const forecastedEarning = rewardRate * creatorBankedBuzz;

  return {
    forecast: {
      bankPortion,
      creatorBankPortion,
      poolValue,
      poolSize,
      earned,
      bankedBuzz,
      creatorBankedBuzz,
      rewardRate,
      forecastedEarning,
    },
    isLoading,
    setBankPortion,
    setCreatorBankPortion,
  };
};

export const useCreatorProgramMutate = () => {
  const utils = trpc.useUtils();
  const joinCreatorsProgramMutation = trpc.creatorProgram.joinCreatorsProgram.useMutation({
    onError(error) {
      handleTRPCError(error, 'Failed to join creators program.');
    },
  });
  const bankBuzzMutation = trpc.creatorProgram.bankBuzz.useMutation({
    onSuccess(_, { amount }) {
      utils.creatorProgram.getCompensationPool.setData({}, (old) => {
        if (!old) return old;
        return { ...old, size: { ...old.size, current: old.size.current + amount } };
      });
      utils.creatorProgram.getBanked.setData(undefined, (old) => {
        if (!old) return old;
        return { ...old, total: old.total + amount };
      });
    },
    onError(error) {
      handleTRPCError(error, 'Failed to bank your Buzz.');
    },
  });
  const withdrawCashMutation = trpc.creatorProgram.withdrawCash.useMutation({
    onSuccess(_, { amount }) {
      utils.creatorProgram.getCash.setData(undefined, (old) => {
        if (!old) return old;
        return {
          ...old,
          ready: old.ready - amount,
          withdrawn: (old.withdrawn ?? 0) + amount,
        };
      });
    },
    onError(error) {
      handleTRPCError(error, 'Failed to withdraw your cash.');
    },
  });
  const extractBuzzMutation = trpc.creatorProgram.extractBuzz.useMutation({
    onSuccess() {
      utils.creatorProgram.getBanked.setData(undefined, (old) => {
        if (!old) return old;
        // Unbank all
        return { ...old, total: 0 };
      });
    },
    onError(error) {
      handleTRPCError(error, 'Failed to extract your Buzz.');
    },
  });

  const handleJoinCreatorsProgram = async () => {
    return joinCreatorsProgramMutation.mutateAsync();
  };

  const handleBankBuzz = async (input: BankBuzzInput) => {
    return bankBuzzMutation.mutateAsync(input);
  };

  const handleWithdrawCash = async (input: WithdrawCashInput) => {
    return withdrawCashMutation.mutateAsync(input);
  };

  const handleExtractBuzz = async () => {
    return extractBuzzMutation.mutateAsync();
  };

  return {
    joinCreatorsProgram: handleJoinCreatorsProgram,
    joiningCreatorsProgram: joinCreatorsProgramMutation.isLoading,
    bankBuzz: handleBankBuzz,
    bankingBuzz: bankBuzzMutation.isLoading,
    withdrawCash: handleWithdrawCash,
    withdrawingCash: withdrawCashMutation.isLoading,
    extractBuzz: handleExtractBuzz,
    extractingBuzz: extractBuzzMutation,
  };
};

export const useCreatorPoolListener = () => {
  const utils = trpc.useUtils();
  useSignalTopic(SignalTopic.CreatorProgram);
  useSignalConnection(SignalMessages.CompensationPoolUpdate, (data: any) => {
    utils.creatorProgram.getCompensationPool.setData({}, (old) => {
      return { ...(old ?? {}), ...(data as CompensationPool) };
    });
  });
  useSignalConnection(SignalMessages.CashInvalidator, (data: any) => {
    utils.creatorProgram.getCash.invalidate();
  });
};
