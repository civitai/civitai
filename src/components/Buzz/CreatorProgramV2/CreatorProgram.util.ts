import dayjs from '~/shared/utils/dayjs';
import { useMemo } from 'react';
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
      utils.creatorProgram.getBanked.invalidate();
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
      utils.creatorProgram.getBanked.invalidate();
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
    joiningCreatorsProgram: joinCreatorsProgramMutation.isPending,
    bankBuzz: handleBankBuzz,
    bankingBuzz: bankBuzzMutation.isPending,
    withdrawCash: handleWithdrawCash,
    withdrawingCash: withdrawCashMutation.isPending,
    extractBuzz: handleExtractBuzz,
    extractingBuzz: extractBuzzMutation.isPending,
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
