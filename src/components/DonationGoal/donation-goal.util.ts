import type { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { handleTRPCError, trpc } from '~/utils/trpc';

export const useMutateDonationGoal = () => {
  const queryUtils = trpc.useUtils();

  const donateMutation = trpc.donationGoal.donate.useMutation({
    async onSuccess(donationGoal, { donationGoalId }) {
      const versionId =
        donationGoal?.entityType === 'ModelVersion' ? donationGoal.entityId : null;
      if (donationGoal && versionId != null) {
        await queryUtils.modelVersion.donationGoal.setData({ id: versionId }, (data) => {
          if (!data || data.id !== donationGoalId) return data ?? null;
          return { ...data, total: donationGoal.total };
        });

        if (donationGoal.total >= donationGoal.goalAmount) {
          // Goal met → the server may have ended the access gate; refresh entity access.
          await queryUtils.common.getEntityAccess.invalidate({
            entityId: [versionId],
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
    donating: donateMutation.isPending,
  };
};
