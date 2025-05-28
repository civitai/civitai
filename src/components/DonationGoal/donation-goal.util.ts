import type { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { handleTRPCError, trpc } from '~/utils/trpc';

export const useMutateDonationGoal = () => {
  const queryUtils = trpc.useUtils();

  const donateMutation = trpc.donationGoal.donate.useMutation({
    async onSuccess(donationGoal, { donationGoalId }) {
      if (donationGoal && donationGoal.modelVersionId) {
        await queryUtils.modelVersion.donationGoals.setData(
          { id: donationGoal.modelVersionId },
          (data) => {
            if (!data) return [];

            const updated = data.map((goal) => {
              if (goal.id === donationGoalId) {
                return {
                  ...goal,
                  // Update it:
                  total: donationGoal.total,
                };
              }

              return goal;
            });

            return updated;
          }
        );

        if (donationGoal.total >= donationGoal.goalAmount && donationGoal.isEarlyAccess) {
          // Refresh user's access, as he might have unlocked it.
          await queryUtils.common.getEntityAccess.invalidate({
            entityId: [donationGoal.modelVersionId],
            entityType: 'ModelVersion',
          });
        }
      }
    },
    onError(error) {
      handleTRPCError(error, 'Failed to donate to goal');
    },
  });

  const handleDonate = (input: DonateToGoalInput) => {
    return donateMutation.mutateAsync(input);
  };

  return {
    donate: handleDonate,
    donating: donateMutation.isLoading,
  };
};
