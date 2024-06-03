import { dbRead, dbWrite } from '~/server/db/client';
import { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType } from '~/server/schema/buzz.schema';
import { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';

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

    buzzTransactionId = transaction.transactionId;

    await dbWrite.donation.create({
      data: {
        amount,
        buzzTransactionId,
        donationGoalId,
        userId,
      },
    });

    // Retuns an updated copy of the goal.
    const updatedDonationGoal = await donationGoalById({ id: donationGoalId, userId });

    if (
      goal.total < goal.goalAmount &&
      updatedDonationGoal.total >= goal.goalAmount &&
      goal.isEarlyAccess &&
      goal.modelVersionId
    ) {
      // This goal was completed, early access should be granted. Fetch the model version to confirm early access still applies and complete it.
      const modelVersion = await dbRead.modelVersion.findUnique({
        where: {
          id: goal.modelVersionId,
        },
        select: {
          earlyAccessConfig: true,
          earlyAccessEndsAt: true,
        },
      });

      if (modelVersion?.earlyAccessEndsAt && modelVersion.earlyAccessEndsAt > new Date()) {
        await dbWrite.$executeRaw`
          UPDATE "ModelVersion"
          SET "earlyAccessConfig" = jsonb_set(
            COALESCE("earlyAccessConfig", '{}'::jsonb),
            '{timeframe}',
            to_jsonb(${0})
          ),
          "earlyAccessEndsAt" = NOW(),
          "availability" = 'Public'
          WHERE "id" = ${goal.modelVersionId}
        `;
      }
    }

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
