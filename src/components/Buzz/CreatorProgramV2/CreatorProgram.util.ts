import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { BankBuzzInput } from '~/server/schema/creator-program.schema';
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
  const { data, isLoading } = trpc.creatorProgram.getCompensationPool.useQuery(undefined, {
    enabled: !!currentUser,
  });

  return {
    compensationPool: data,
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
    isLoading,
  };
};

export const useCreatorProgramPhase = () => {
  const { compensationPool, isLoading } = useCompensationPool();
  const now = new Date();

  const phase = compensationPool?.phases
    ? (Object.keys(compensationPool?.phases).find((phase) => {
        const [start, end] =
          compensationPool?.phases[phase as keyof (typeof compensationPool)['phases']];

        return start <= now && now <= end;
      }) as keyof (typeof compensationPool)['phases'])
    : undefined;

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
  const joinCreatorsProgramMutation = trpc.creatorProgram.joinCreatorsProgram.useMutation({
    onError(error) {
      handleTRPCError(error, 'Failed to join creators program.');
    },
  });
  const bankBuzzMutation = trpc.creatorProgram.bankBuzz.useMutation({
    onError(error) {
      handleTRPCError(error, 'Failed to bank your buzz.');
    },
  });

  const handleJoinCreatorsProgram = async () => {
    return joinCreatorsProgramMutation.mutateAsync();
  };

  const handleBankBuzz = async (input: BankBuzzInput) => {
    return bankBuzzMutation.mutateAsync(input);
  };

  return {
    joinCreatorsProgram: handleJoinCreatorsProgram,
    joiningCreatorsProgram: joinCreatorsProgramMutation.isLoading,
    bankBuzz: handleBankBuzz,
    bankingBuzz: bankBuzzMutation.isLoading,
  };
};
