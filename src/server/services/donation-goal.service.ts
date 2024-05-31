import { dbRead, dbWrite } from '~/server/db/client';
import { TransactionType } from '~/server/schema/buzz.schema';
import { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import { createBuzzTransaction } from '~/server/services/buzz.service';

export const donateToGoal = async ({
  donationGoalId,
  amount,
  userId,
}: DonateToGoalInput & {
  userId: number;
}) => {
  const goal = await dbRead.donationGoal.findFirst({
    where: { id: donationGoalId },
  });

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
