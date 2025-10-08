import dayjs from 'dayjs';
import type { NextApiRequest, NextApiResponse } from 'next';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import {
  getCompensationPool,
  getPoolParticipants,
  getPoolParticipantsV2,
} from '~/server/services/creator-program.service';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { withRetries } from '~/utils/errorHandling';

export default PublicEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const month = dayjs().subtract(1, 'month').toDate();
  const pool = await getCompensationPool({ month });
  const v2 = await getPoolParticipantsV2(month);
  const v1 = await getPoolParticipants(month);

  const diff = v2
    .map((item) => {
      const match = v1.find((i) => i.userId === item.userId);
      return {
        userId: item.userId,
        data: item,
        match,
      };
    })
    .filter((item) => !item.match);

  if (diff.length === 0) {
    return res.status(200).json({ allocations: [] });
  }

  const allocations: [number, number][] = [];
  let availablePoolValue = Math.floor(pool.value * 100);
  for (const participant of v2) {
    // If we're out of pool value, we're done... (sorry folks)
    if (availablePoolValue <= 0) break;

    // Determine participant share
    const participantPortion = participant.amount / pool.size.current;
    let participantShare = Math.floor(pool.value * participantPortion * 100);
    const perBuzzValue = participantShare / participant.amount;
    // Cap Buzz value
    if (perBuzzValue > CAPPED_BUZZ_VALUE) participantShare = participant.amount * CAPPED_BUZZ_VALUE;

    // Set allocation
    if (diff.find((d) => d.userId === participant.userId)) {
      allocations.push([participant.userId, participantShare]);
    }

    availablePoolValue -= participantShare;
  }

  const monthStr = dayjs(month).format('YYYY-MM');
  if (allocations.length > 0) {
    await withRetries(async () => {
      createBuzzTransactionMany(
        allocations.map(([userId, amount]) => ({
          type: TransactionType.Compensation,
          toAccountType: 'cashpending',
          toAccountId: userId,
          fromAccountId: 0, // central bank
          amount,
          description: `Compensation Pool for ${monthStr}`,
          details: { month },
          externalTransactionId: `comp-pool-${monthStr}-${userId}`,
        }))
      );
    });
  }

  return res.status(200).json({
    allocations,
  });
});
