/*
 * Creator Program payout backfill — one-off correction for the green+yellow double-count bug.
 *
 * Bug: getPoolParticipantsV2 returned one contributor row per (userId, source buzz type). The
 * distribute job then wrote two cashPending grants sharing externalTransactionId
 * `comp-pool-unified-<month>-<userId>`, and the buzz service deduped the second as a conflict —
 * so each creator who banked BOTH green and yellow was paid for only one of the two types.
 *
 * This endpoint re-runs the (now-fixed) distribution for a settled month, compares each creator's
 * correct share against what they were actually paid, and grants only the difference under a
 * distinct `comp-pool-unified-<month>-<userId>-fix` externalTransactionId. Idempotent: re-running
 * finds the -fix grant already present (its amount folds into "already paid") and computes a 0 top-up.
 *
 * Actions (POST JSON body):
 *   { month?: 'YYYY-MM', dryRun?: boolean }
 *     month  — settled month to backfill (default '2026-06')
 *     dryRun — when true (default) compute and return the plan WITHOUT moving any buzz
 *
 * Always run dry first and eyeball totalTopUp. Set dryRun=false to actually grant the top-ups.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import dayjs from '~/shared/utils/dayjs';
import * as z from 'zod';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { SignalMessages, SignalTopic } from '~/server/common/enums';
import {
  getCompensationPool,
  getPoolParticipantsV2,
  userCashCache,
} from '~/server/services/creator-program.service';
import {
  createBuzzTransactionMany,
  getTransactionByExternalId,
} from '~/server/services/buzz.service';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import { CAPPED_BUZZ_VALUE } from '~/shared/constants/creator-program.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { signalClient } from '~/utils/signal-client';

const schema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .default('2026-06'),
  // Default true, and treat the strings 'false'/'0' as false so a stray string body can't move money.
  dryRun: z
    .preprocess((v) => (v === 'false' || v === '0' || v === false ? false : true), z.boolean())
    .default(true),
});

export default WebhookEndpoint(async (req: NextApiRequest, res: NextApiResponse) => {
  const { month: monthStr, dryRun } = schema.parse(req.body ?? {});
  const month = dayjs(`${monthStr}-15T12:00:00Z`).toDate();

  const pool = await getCompensationPool({ month });
  const participants = await getPoolParticipantsV2(month, false);

  if (pool.size.current <= 0) {
    return res.status(200).json({ month: monthStr, error: 'pool size is 0', participants: 0 });
  }

  // Recompute each participant's correct share exactly as creatorsProgramDistribute does, now that
  // getPoolParticipantsV2 returns one summed row per creator (green + yellow combined).
  let availablePoolValue = Math.floor(pool.value * 100);
  const correctShares = new Map<number, number>();
  for (const participant of participants) {
    if (availablePoolValue <= 0) break;
    const participantPortion = participant.amount / pool.size.current;
    let participantShare = Math.floor(pool.value * participantPortion * 100);
    const perBuzzValue = participantShare / participant.amount;
    if (perBuzzValue > CAPPED_BUZZ_VALUE) participantShare = participant.amount * CAPPED_BUZZ_VALUE;
    correctShares.set(participant.userId, participantShare);
    availablePoolValue -= participantShare;
  }

  // For each creator, subtract what actually landed (original grant + any prior -fix grant).
  const rows = await limitConcurrency(
    Array.from(correctShares.entries()).map(([userId, correctShare]) => async () => {
      const [original, priorFix] = await Promise.all([
        getTransactionByExternalId(`comp-pool-unified-${monthStr}-${userId}`),
        getTransactionByExternalId(`comp-pool-unified-${monthStr}-${userId}-fix`),
      ]);
      const alreadyPaid = (original?.amount ?? 0) + (priorFix?.amount ?? 0);
      return { userId, correctShare, alreadyPaid, topUp: correctShare - alreadyPaid };
    }),
    10
  );

  const topUps = rows.filter((r) => r.topUp > 0);
  const totalTopUp = topUps.reduce((sum, r) => sum + r.topUp, 0);

  if (!dryRun && topUps.length > 0) {
    await createBuzzTransactionMany(
      topUps.map(({ userId, topUp }) => ({
        type: TransactionType.Compensation,
        toAccountType: 'cashPending',
        toAccountId: userId,
        fromAccountId: 0, // central bank
        amount: topUp,
        description: `Compensation Pool backfill for ${monthStr}`,
        details: { month, backfill: 'green-yellow-double-count' },
        externalTransactionId: `comp-pool-unified-${monthStr}-${userId}-fix`,
      }))
    );

    await userCashCache.bust(topUps.map((r) => r.userId));
    await signalClient.topicSend({
      topic: SignalTopic.CreatorProgram,
      target: SignalMessages.CashInvalidator,
      data: {},
    });
  }

  return res.status(200).json({
    month: monthStr,
    dryRun,
    poolValueUsd: pool.value,
    poolSize: pool.size.current,
    participants: participants.length,
    affectedCreators: topUps.length,
    totalTopUpCents: totalTopUp,
    totalTopUpUsd: totalTopUp / 100,
    rows: topUps.sort((a, b) => b.topUp - a.topUp),
  });
});
