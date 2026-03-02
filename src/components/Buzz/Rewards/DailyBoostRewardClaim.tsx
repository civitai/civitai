import { Button } from '@mantine/core';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

/**
 * Hook to get daily boost reward state for conditional rendering.
 * Returns the reward data and claim mutation for external use.
 */
export function useDailyBoostReward() {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useUtils();
  const { data: rewards = [], isLoading: loadingRewards } = trpc.user.userRewardDetails.useQuery(
    undefined,
    { enabled: !!currentUser }
  );
  const { mutate: claim, isLoading: isClaiming } = trpc.buzz.claimDailyBoostReward.useMutation({
    onSuccess: async () => {
      await queryUtils.user.userRewardDetails.invalidate();
    },
  });
  const status = useGenerationStatus();

  const dailyBoostReward = rewards.find((reward) => reward.type === 'dailyBoost');
  const isClaimed = dailyBoostReward ? dailyBoostReward.awarded > 0 : true;
  const canShow = !!currentUser && !loadingRewards && !!status?.charge && !!dailyBoostReward && !isClaimed;

  return {
    canShow,
    awardAmount: dailyBoostReward?.awardAmount ?? 0,
    claim,
    isClaiming,
  };
}

export const DailyBoostRewardClaim = () => {
  const { canShow, awardAmount, claim, isClaiming } = useDailyBoostReward();

  if (!canShow) {
    return null;
  }

  return (
    <Button
      size="compact-xs"
      color="blue.4"
      loading={isClaiming}
      onClick={() => claim()}
      variant="outline"
    >
      Claim {awardAmount} Buzz
    </Button>
  );
};
