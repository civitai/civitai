/**
 * One-time endpoint to fix users who were over-refunded.
 *
 * These users received more refund buzz than their invalid bonuses warranted.
 * This endpoint queries ClickHouse to find the refund transactions and reverses them.
 *
 * Run with:
 *   GET /api/admin/temp/fix-over-refunded-users?token=WEBHOOK_TOKEN
 *   GET /api/admin/temp/fix-over-refunded-users?token=WEBHOOK_TOKEN&dryRun=true
 */

import type { NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { refundTransaction } from '~/server/services/buzz.service';
import { clickhouse } from '~/server/clickhouse/client';

// Users who were over-refunded - they received more refund buzz than their invalid bonuses
// Generated from validate-all-prepaid-memberships-output.json on 2026-01-14
// Total: 189 users (158 active + 31 ended subscriptions)
const OVER_REFUNDED_USER_IDS: number[] = [
  // Active subscriptions (158 users)
  9363165, 9518845, 2179540, 3480499, 6595900, 42796, 5540710, 5142420, 3265064, 5544691, 5886059,
  6712826, 7623855, 2739449, 45263, 9382272, 3870597, 5171378, 2951235, 7461066, 3598911, 7723279,
  936273, 2060553, 8999704, 6623266, 5769821, 176330, 2850189, 7364713, 3711664, 1654272, 9055494,
  7812782, 4513803, 4202454, 9759317, 798853, 6343040, 9411076, 5338087, 4306200, 4831805, 9276281,
  5148983, 193938, 5888729, 7250485, 7296284, 2426794, 2895123, 2870628, 6505043, 4769922, 4251616,
  3922961, 4047559, 5155520, 2604164, 7073168, 6897709, 5056222, 5068569, 460836, 6274283, 3243024,
  4988916, 7957509, 4533829, 2729330, 3106218, 3955861, 5943831, 4269611, 8810905, 2241374, 5002840,
  3632457, 3496058, 4943517, 5617504, 4789838, 5990517, 4109690, 3774704, 6100372, 9572620, 4799792,
  8238560, 8062118, 9344941, 2168154, 3045637, 3376457, 2668603, 4143652, 6098407, 1155875, 857331,
  4794698, 9776528, 5135322, 6899924, 9662456, 1447490, 6900017, 2937931, 5820351, 3352098, 3352910,
  4808275, 3452255, 1225049, 6170180, 8353244, 3422338, 5498610, 2192962, 2884551, 3946635, 5998823,
  5523050, 7281598, 9757407, 3462203, 7733380, 6664431, 1540509, 4665296, 6940135, 3694695, 5220320,
  4810838, 5493491, 2220995, 5466199, 4669965, 9574398, 2824026, 2768761, 1529106, 5002059, 2972008,
  2143238, 6364061, 3612603, 5612334, 1901332, 3265792, 6417413, 4889557, 4158253, 5513149, 2708843,
  997697, 2653243, 224761, 6046926,
  // Ended subscriptions (31 users)
  5934249, 9749171, 4360352, 6562960, 8506203, 587727, 7728448, 3657360, 9201880, 9696683, 3482112,
  1638041, 9599094, 4813336, 9588060, 9464126, 9743268, 8644817, 4388828, 7143462, 7348581, 8721697,
  9739774, 190042, 2625696, 3444873, 7611823, 2358433, 9210938, 4041062, 1072356,
];

const REFUND_EXTERNAL_ID_PREFIX = 'buzz-correction-2026-01-06';

type RefundTransactionRow = {
  transactionId: string;
  fromAccountId: number;
  amount: number;
  externalTransactionId: string;
};

export default WebhookEndpoint(async (req, res: NextApiResponse) => {
  const dryRun = req.query.dryRun === 'true';

  console.log(`[fix-over-refunded-users] Starting ${dryRun ? '(DRY RUN)' : ''}`);
  console.log(`[fix-over-refunded-users] Users to process: ${OVER_REFUNDED_USER_IDS.length}`);

  // Step 1: Query ClickHouse to get the transaction IDs for these refunds
  console.log(`[fix-over-refunded-users] Querying ClickHouse for refund transactions...`);

  const refundTransactions = await clickhouse!.$query<RefundTransactionRow>`
    SELECT
      transactionId,
      fromAccountId,
      amount,
      externalTransactionId
    FROM buzzTransactions
    WHERE fromAccountId IN (${OVER_REFUNDED_USER_IDS})
    AND type = 'refund'
    AND externalTransactionId LIKE '${REFUND_EXTERNAL_ID_PREFIX}%'
  `;

  console.log(`[fix-over-refunded-users] Found ${refundTransactions.length} refund transactions`);

  // Create a map of userId -> transaction for quick lookup
  const transactionsByUser = new Map<number, RefundTransactionRow>();
  for (const tx of refundTransactions) {
    transactionsByUser.set(tx.fromAccountId, tx);
  }

  const results: {
    userId: number;
    externalTransactionId: string;
    transactionId?: string;
    status: 'success' | 'skipped' | 'error';
    error?: string;
    amount?: number;
  }[] = [];

  for (const userId of OVER_REFUNDED_USER_IDS) {
    const expectedExternalId = `${REFUND_EXTERNAL_ID_PREFIX}-${userId}`;
    const transaction = transactionsByUser.get(userId);

    if (!transaction) {
      console.log(`  [SKIP] User ${userId} - no refund transaction found`);
      results.push({
        userId,
        externalTransactionId: expectedExternalId,
        status: 'skipped',
        error: 'Transaction not found in ClickHouse',
      });
      continue;
    }

    try {
      if (dryRun) {
        console.log(
          `  [DRY RUN] Would refund ${transaction.externalTransactionId} (${
            transaction.transactionId
          }) - ${Math.abs(transaction.amount)} buzz`
        );
        results.push({
          userId,
          externalTransactionId: transaction.externalTransactionId,
          transactionId: transaction.transactionId,
          amount: Math.abs(transaction.amount),
          status: 'success',
        });
        continue;
      }

      // Refund the transaction
      await refundTransaction(
        transaction.transactionId,
        'Reversal of incorrect over-refund from 2026-01-06'
      );

      console.log(
        `  [OK] Refunded ${transaction.externalTransactionId} (${
          transaction.transactionId
        }) - ${Math.abs(transaction.amount)} buzz`
      );
      results.push({
        userId,
        externalTransactionId: transaction.externalTransactionId,
        transactionId: transaction.transactionId,
        amount: Math.abs(transaction.amount),
        status: 'success',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`  [ERROR] Failed to process user ${userId}: ${msg}`);
      results.push({
        userId,
        externalTransactionId: transaction.externalTransactionId,
        transactionId: transaction.transactionId,
        status: 'error',
        error: msg,
      });
    }
  }

  const successful = results.filter((r) => r.status === 'success');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'error');
  const totalBuzzRefunded = successful.reduce((sum, r) => sum + (r.amount ?? 0), 0);

  console.log(`[fix-over-refunded-users] Complete`);
  console.log(`  Success: ${successful.length}`);
  console.log(`  Skipped: ${skipped.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log(`  Total buzz to refund: ${totalBuzzRefunded.toLocaleString()}`);

  return res.status(200).json({
    success: true,
    dryRun,
    summary: {
      total: OVER_REFUNDED_USER_IDS.length,
      successful: successful.length,
      skipped: skipped.length,
      failed: failed.length,
      totalBuzzRefunded,
    },
    results,
  });
});
