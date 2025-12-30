import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { z } from 'zod';
import { createBuzzTransactionMany, getAccountsBalances } from '~/server/services/buzz.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { booleanString } from '~/utils/zod-helpers';
import { chunk } from 'lodash-es';

// Configurable constants
const BATCH_SIZE = 5;
const CONCURRENCY = 5;
const TODAY_DATE = '2024-12-10';

const querySchema = z.object({
  dryRun: booleanString().default(true),
});

// User data from the reclaim list
const USERS_TO_RECLAIM: { userId: number; amount: number }[] = [];

type ReclaimResult = {
  userId: number;
  targetAmount: number;
  balance: number;
  reclaimedAmount: number;
  skipped: boolean;
  reason?: string;
};

// Helper to process a batch of users with parallel balance fetching
async function processBatch(
  batch: { userId: number; amount: number }[],
  dryRun: boolean,
  log: (msg: string) => void
): Promise<ReclaimResult[]> {
  const results: ReclaimResult[] = [];

  // Fetch all balances for the batch in parallel
  const userIds = batch.map((u) => u.userId);
  const balances = await getAccountsBalances({
    accountIds: userIds,
    accountTypes: ['yellow'],
  });

  // Create a map for quick lookup
  const balanceMap = new Map(balances.map((b) => [b.accountId, b.balance]));

  // Prepare transactions for this batch
  const transactions: {
    fromAccountId: number;
    toAccountId: number;
    amount: number;
    type: TransactionType;
    description: string;
    externalTransactionId: string;
    fromAccountType: 'yellow';
  }[] = [];

  for (const user of batch) {
    const balance = balanceMap.get(user.userId) ?? 0;
    const reclaimAmount = Math.min(balance, user.amount);

    if (reclaimAmount <= 0) {
      results.push({
        userId: user.userId,
        targetAmount: user.amount,
        balance,
        reclaimedAmount: 0,
        skipped: true,
        reason: balance <= 0 ? 'No balance available' : 'Balance is zero',
      });
      continue;
    }

    results.push({
      userId: user.userId,
      targetAmount: user.amount,
      balance,
      reclaimedAmount: reclaimAmount,
      skipped: false,
    });

    if (!dryRun) {
      transactions.push({
        fromAccountId: user.userId,
        toAccountId: 0, // Central bank
        amount: reclaimAmount,
        type: TransactionType.Refund,
        description: 'Free Membership Renewal Error Correction Reclaim',
        externalTransactionId: `buzz-correction-${TODAY_DATE}-${user.userId}`,
        fromAccountType: 'yellow',
      });
    }
  }

  // Execute transactions if not dry run
  if (!dryRun && transactions.length > 0) {
    await createBuzzTransactionMany(transactions);
    log(`Processed ${transactions.length} transactions in batch`);
  }

  return results;
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const log = (msg: string) => console.log(`[ReclaimMembershipBuzz] ${msg}`);

  // Parse query parameters
  const queryResult = querySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: queryResult.error });
  }

  const { dryRun } = queryResult.data;

  log(`Starting membership buzz reclaim... (dryRun: ${dryRun})`);
  log(
    `Processing ${USERS_TO_RECLAIM.length} users with BATCH_SIZE=${BATCH_SIZE}, CONCURRENCY=${CONCURRENCY}`
  );

  const allResults: ReclaimResult[] = [];
  const batches = chunk(USERS_TO_RECLAIM, BATCH_SIZE);

  // Process batches with concurrency
  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const concurrentBatches = batches.slice(i, i + CONCURRENCY);
    log(
      `Processing batches ${i + 1}-${Math.min(i + CONCURRENCY, batches.length)} of ${
        batches.length
      }`
    );

    const batchPromises = concurrentBatches.map((batch) => processBatch(batch, dryRun, log));
    const batchResults = await Promise.all(batchPromises);

    for (const results of batchResults) {
      allResults.push(...results);
    }
  }

  // Calculate summary
  const summary = {
    totalUsers: USERS_TO_RECLAIM.length,
    processedUsers: allResults.length,
    skippedUsers: allResults.filter((r) => r.skipped).length,
    totalTargetAmount: USERS_TO_RECLAIM.reduce((sum, u) => sum + u.amount, 0),
    totalReclaimedAmount: allResults.reduce((sum, r) => sum + r.reclaimedAmount, 0),
    usersWithPartialReclaim: allResults.filter(
      (r) => !r.skipped && r.reclaimedAmount < r.targetAmount
    ).length,
  };

  log(`Reclaim complete. Total reclaimed: ${summary.totalReclaimedAmount}`);
  log(`Skipped: ${summary.skippedUsers}, Partial: ${summary.usersWithPartialReclaim}`);

  return res.status(200).json({
    success: true,
    dryRun,
    summary,
    details: allResults,
  });
});
