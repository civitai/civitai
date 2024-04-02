import { Button } from '@mantine/core';
import { useGenerationStatus } from '~/components/ImageGeneration/GenerationForm/generation.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { trpc } from '~/utils/trpc';

export const DailyBoostRewardClaim = () => {
  const currentUser = useCurrentUser();
  const queryUtils = trpc.useContext();
  const { data: rewards = [], isLoading: loadingRewards } = trpc.user.userRewardDetails.useQuery(
    undefined,
    {
      enabled: !!currentUser,
    }
  );
  const { mutate, isLoading } = trpc.buzz.claimDailyBoostReward.useMutation({
    onSuccess: async () => {
      await queryUtils.user.userRewardDetails.invalidate();
    },
  });
  const status = useGenerationStatus();

  if (!currentUser || loadingRewards || !status?.charge) {
    return null;
  }

  const dailyBoostReward = rewards.find((reward) => reward.type === 'dailyBoost');

  if (!dailyBoostReward) {
    return null;
  }

  const isClaimed = dailyBoostReward.awarded > 0;

  if (isClaimed) {
    return null;
  }

  return (
    <Button
      compact
      size="xs"
      color="yellow.7"
      loading={isLoading}
      onClick={() => mutate()}
      variant="outline"
    >
      Claim {dailyBoostReward.awardAmount} Buzz
    </Button>
  );
};
