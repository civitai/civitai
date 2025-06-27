import { dbRead, dbWrite } from '~/server/db/client';
import { dataForModelsCache } from '~/server/redis/caches';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import type { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { updateModelEarlyAccessDeadline } from '~/server/services/model.service';

export const donationGoalById = async ({
  id,
  userId,
  isModerator,
}: GetByIdInput & { userId?: number; isModerator?: boolean }) => {
  const donationGoal = await dbWrite.donationGoal.findUniqueOrThrow({
    where: {
      id,
    },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      isEarlyAccess: true,
      userId: true,
      createdAt: true,
      modelVersionId: true,
    },
  });

  if (!donationGoal.active && (!isModerator || donationGoal.userId === userId)) {
    throw new Error('Goal not found');
  }

  const [data] = await dbWrite.$queryRaw<{ total: number }[]>`
    SELECT
      SUM("amount")::int as total
    FROM "Donation"
    WHERE "donationGoalId" = ${id}
  `;

  return { ...donationGoal, total: data?.total ?? 0 };
};

export const donateToGoal = async ({
  donationGoalId,
  amount,
  userId,
}: DonateToGoalInput & {
  userId: number;
}) => {
  const goal = await donationGoalById({ id: donationGoalId, userId });

  if (!goal) {
    throw new Error('Goal not found');
  }

  if (!goal.active) {
    throw new Error('Goal is not active');
  }

  if (goal.userId === userId) {
    throw new Error('User cannot donate to their own goal');
  }

  let buzzTransactionId;

  try {
    const transaction = await createBuzzTransaction({
      amount,
      fromAccountId: userId,
      toAccountId: goal.userId,
      description: `Donation to ${goal.title}`,
      type: TransactionType.Donation,
    });
    if (!transaction.transactionId) {
      throw new Error('There was an error creating the transaction.');
    }

    buzzTransactionId = transaction.transactionId;

    await dbWrite.donation.create({
      data: {
        amount,
        buzzTransactionId,
        donationGoalId,
        userId,
      },
    });

    // Returns an updated copy of the goal.
    const updatedDonationGoal = await checkDonationGoalComplete({ donationGoalId });
    return updatedDonationGoal;
  } catch (e) {
    if (buzzTransactionId) {
      // Refund:
      await createBuzzTransaction({
        amount,
        fromAccountId: goal.userId,
        toAccountId: userId,
        description: `Refund for failed donation to ${goal.title}`,
        type: TransactionType.Refund,
        externalTransactionId: buzzTransactionId,
      });
    }
    throw new Error('Failed to create donation');
  }
};

export const checkDonationGoalComplete = async ({ donationGoalId }: { donationGoalId: number }) => {
  const goal = await donationGoalById({ id: donationGoalId, isModerator: true }); // Force is moderator since this unlocks the goal.
  const isGoalMet = goal.total >= goal.goalAmount;
  if (goal.isEarlyAccess && goal.modelVersionId && isGoalMet) {
    // Mark goal as complete.
    await dbWrite.donationGoal.update({
      where: { id: donationGoalId },
      data: { active: false },
    });
    goal.active = false;

    // This goal was completed, early access should be granted. Fetch the model version to confirm early access still applies and complete it.
    const modelVersion = await dbRead.modelVersion.findUnique({
      where: {
        id: goal.modelVersionId,
      },
      select: {
        earlyAccessConfig: true,
        earlyAccessEndsAt: true,
        modelId: true,
      },
    });

    if (modelVersion?.earlyAccessEndsAt && modelVersion.earlyAccessEndsAt > new Date()) {
      await dbWrite.$executeRaw`
        UPDATE "ModelVersion"
        SET "earlyAccessConfig" =
          COALESCE("earlyAccessConfig", '{}'::jsonb)  || JSONB_BUILD_OBJECT(
            'timeframe', 0,
            'originalPublishedAt', "publishedAt",
            'originalTimeframe', "earlyAccessConfig"->>'timeframe'
          ),
        "earlyAccessEndsAt" = NULL,
        "availability" = 'Public',
        "publishedAt" = NOW()
        WHERE "id" = ${goal.modelVersionId}
      `;

      await updateModelEarlyAccessDeadline({
        id: modelVersion.modelId,
      }).catch((e) => {
        console.error('Unable to update model early access deadline');
        console.error(e);
      });

      // Ensures user gets access to the resource after purchasing.
      await bustMvCache(goal.modelVersionId, modelVersion.modelId);
      await dataForModelsCache.bust(modelVersion.modelId);
    }
  }

  return goal;
};
