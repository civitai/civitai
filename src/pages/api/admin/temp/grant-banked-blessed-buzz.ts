import type { NextApiRequest, NextApiResponse } from 'next';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { chunk } from 'lodash-es';
import { z } from 'zod';
import { blessedBuzzCounter } from '~/server/games/new-order/utils';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { createNotification } from '~/server/services/notification.service';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { newOrderConfig } from '~/server/common/constants';
import { NewOrderRankType } from '~/shared/utils/prisma/enums';
import { NotificationCategory } from '~/server/common/enums';
import { booleanString } from '~/utils/zod-helpers';

const querySchema = z.object({
  dryRun: booleanString().default(true),
});

type PlayerBalance = {
  userId: number;
  rankType: NewOrderRankType;
  totalBlessedBuzz: number;
  balance: number;
};

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const log = (msg: string) => console.log(`[BankedBlessedBuzz] ${msg}`);

  // Parse query parameters
  const queryResult = querySchema.safeParse(req.query);
  if (!queryResult.success) {
    return res.status(400).json({ error: 'Invalid query parameters', details: queryResult.error });
  }

  const { dryRun } = queryResult.data;

  log(`Starting banked blessed buzz payout... (dryRun: ${dryRun})`);

  // 1. Get all players with blessed buzz from Redis counter
  const allBlessedBuzz = await blessedBuzzCounter.getAll({ withCount: true });
  log(`Found ${allBlessedBuzz.length} players with blessed buzz in Redis`);

  // 2. Filter out players with 0 blessed buzz and convert to numbers
  const playersWithBuzz = allBlessedBuzz
    .map((entry) => ({
      userId: Number(entry.value),
      totalBlessedBuzz: entry.score,
    }))
    .filter((player) => player.totalBlessedBuzz > 0);

  log(`Filtered to ${playersWithBuzz.length} players with positive blessed buzz`);

  // 3. Get player data from database to check rank eligibility (Knights/Templars only)
  const playerIds = playersWithBuzz.map((p) => p.userId);
  const eligiblePlayers = await dbRead.newOrderPlayer.findMany({
    where: {
      userId: { in: playerIds },
      rankType: { not: NewOrderRankType.Acolyte },
    },
    select: { userId: true, rankType: true },
  });

  log(`Found ${eligiblePlayers.length} eligible players (Knights/Templars)`);

  // 4. Create player balances with buzz calculations
  const playerBalances: PlayerBalance[] = eligiblePlayers.map((player) => {
    const blessedBuzzData = playersWithBuzz.find((p) => p.userId === player.userId)!;
    const totalBlessedBuzz = blessedBuzzData.totalBlessedBuzz;

    // Calculate buzz with minimum 1 buzz guarantee
    const calculatedBuzz = Math.floor(totalBlessedBuzz * newOrderConfig.blessedBuzzConversionRatio);
    const balance = Math.max(1, calculatedBuzz); // Minimum 1 buzz for any positive exp

    return {
      userId: player.userId,
      rankType: player.rankType,
      totalBlessedBuzz,
      balance,
    };
  });

  log(`Found ${playerBalances.length} players with banked blessed buzz`);

  if (playerBalances.length === 0) {
    return res.status(200).json({
      success: true,
      dryRun,
      message: 'No banked blessed buzz found',
      playerCount: 0,
      totalBuzzPaid: 0,
    });
  }

  // Calculate totals for reporting
  const totalBuzzAmount = playerBalances.reduce((sum, p) => sum + p.balance, 0);
  const playersUnder1000Exp = playerBalances.filter((p) => p.totalBlessedBuzz < 1000).length;

  log(`Total buzz to distribute: ${totalBuzzAmount}`);
  log(`Players receiving minimum 1 buzz (exp < 1000): ${playersUnder1000Exp}`);

  // 3. DRY RUN: Return preview without executing
  if (dryRun) {
    log('DRY RUN MODE - No transactions or notifications will be created');
    return res.status(200).json({
      success: true,
      dryRun: true,
      preview: {
        playerCount: playerBalances.length,
        totalBuzzPaid: totalBuzzAmount,
        playersWithMinimumPayout: playersUnder1000Exp,
        samplePayouts: playerBalances.slice(0, 10), // Show first 10 as sample
      },
      fullDetails: playerBalances,
    });
  }

  // 4. LIVE RUN: Create buzz transactions in batches
  const batches = chunk(playerBalances, 100);
  let transactionsCreated = 0;
  let notificationsSent = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log(`Processing batch ${i + 1} of ${batches.length}`);

    const timestamp = Date.now();
    const transactions = batch.map((player) => ({
      fromAccountId: 0,
      toAccountId: player.userId,
      amount: player.balance,
      type: TransactionType.Reward,
      description: 'Content Moderation - Banked Rewards Recovery',
      externalTransactionId: `new-order-recovery-${player.userId}-${timestamp}`,
    }));

    // Create buzz transactions
    await createBuzzTransactionMany(transactions);
    transactionsCreated += transactions.length;

    // Send notifications to each player
    await Promise.all(
      batch.map((player) =>
        createNotification({
          category: NotificationCategory.Other,
          type: 'new-order-blessed-buzz-granted',
          key: `new-order-blessed-buzz-granted:${player.userId}:${timestamp}`,
          userId: player.userId,
          details: { buzzAmount: player.balance, totalBlessedBuzz: player.totalBlessedBuzz },
        }).catch((error: Error) => {
          log(`Failed to send notification to user ${player.userId}: ${error.message}`);
        })
      )
    );
    notificationsSent += batch.length;

    // Clear the blessed buzz counter for paid players
    await Promise.all(
      batch.map((player) =>
        blessedBuzzCounter.decrement({ id: player.userId, value: player.totalBlessedBuzz })
      )
    );

    log(
      `Batch ${i + 1} complete: ${transactions.length} transactions, ${batch.length} notifications`
    );
  }

  log(`Payout complete: ${playerBalances.length} players, ${totalBuzzAmount} total buzz`);
  log(`Transactions created: ${transactionsCreated}`);
  log(`Notifications sent: ${notificationsSent}`);

  return res.status(200).json({
    success: true,
    dryRun: false,
    summary: {
      playerCount: playerBalances.length,
      totalBuzzPaid: totalBuzzAmount,
      transactionsCreated,
      notificationsSent,
      playersWithMinimumPayout: playersUnder1000Exp,
    },
    details: playerBalances,
  });
});
