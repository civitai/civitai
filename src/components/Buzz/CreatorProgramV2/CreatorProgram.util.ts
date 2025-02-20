import { useState } from 'react';
import { useCurrentUser } from '~/hooks/useCurrentUser';
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

  const handleJoinCreatorsProgram = async () => {
    return joinCreatorsProgramMutation.mutateAsync();
  };

  return {
    joinCreatorsProgram: handleJoinCreatorsProgram,
    joiningCreatorsProgram: joinCreatorsProgramMutation.isLoading,
  };
};
