import { modelVersionAccessInput } from '~/components/Model/ModelVersions/model-version.utils';
import type { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { handleTRPCError, trpc } from '~/utils/trpc';
import { submissionIntent, withPaymentIntentKey } from '~/components/Buzz/payment-intent-keys';

export const useMutateDonationGoal = () => {
  const queryUtils = trpc.useUtils();

  const donateMutation = trpc.donationGoal.donate.useMutation({
    async onSuccess(donationGoal, { donationGoalId }) {
      const versionId = donationGoal?.entityType === 'ModelVersion' ? donationGoal.entityId : null;
      if (donationGoal && versionId != null) {
        await queryUtils.modelVersion.donationGoal.setData({ id: versionId }, (data) => {
          if (!data || data.id !== donationGoalId) return data ?? null;
          return { ...data, total: donationGoal.total };
        });

        if (donationGoal.total >= donationGoal.goalAmount) {
          // Goal met → the server may have ended the access gate; refresh entity access.
          await queryUtils.common.getEntityAccess.invalidate(modelVersionAccessInput(versionId));
        }
      }
    },
    onError(error) {
      handleTRPCError(error, 'Failed to donate to goal');
    },
  });

  // One key per donation (goal and amount), held across a failure that may have charged it, so
  // donating again is the same donation, charged once.
  const handleDonate = (input: Omit<DonateToGoalInput, 'idempotencyKey'>) =>
    withPaymentIntentKey(submissionIntent('donation', input), (idempotencyKey) =>
      donateMutation.mutateAsync({ ...input, idempotencyKey })
    );

  return {
    donate: handleDonate,
    donating: donateMutation.isPending,
  };
};
