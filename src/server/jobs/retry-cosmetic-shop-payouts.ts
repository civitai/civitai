import { createJob } from './job';
import { dbWrite } from '~/server/db/client';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { logToAxiom } from '~/server/logging/client';
import { cosmeticPayoutDeadLetterGauge } from '~/server/prom/client';
import { limitConcurrency } from '~/server/utils/concurrency-helpers';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createLogger } from '~/utils/logging';

const log = createLogger('retry-cosmetic-shop-payouts', 'green');

const MAX_ATTEMPTS = 5;
const BATCH_SIZE = 100;

type DeadLetterRow = {
  id: number;
  externalTransactionId: string;
  recipientUserId: number;
  buyerId: number;
  amount: number;
  originalAmount: number;
  buzzType: string;
  description: string;
};

export const retryCosmeticShopPayouts = createJob(
  'retry-cosmetic-shop-payouts',
  '*/10 * * * *',
  async () => {
    const rows = await dbWrite.cosmeticShopPayoutDeadLetter.findMany({
      where: { resolvedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
      select: {
        id: true,
        externalTransactionId: true,
        recipientUserId: true,
        buyerId: true,
        amount: true,
        originalAmount: true,
        buzzType: true,
        description: true,
      },
    });

    if (rows.length) {
      log(`Retrying ${rows.length} unpaid cosmetic payouts`);
      await limitConcurrency(
        rows.map((row) => async () => settlePayout(row)),
        5
      );
    }

    await publishDeadLetterGauge();
  }
);

async function settlePayout(row: DeadLetterRow) {
  try {
    // One payout per call: the batch endpoint reports successes as opaque transaction ids, so a
    // multi-row batch can't be attributed back to the rows that actually settled.
    const result = await createBuzzTransactionMany([
      {
        fromAccountId: 0,
        toAccountId: row.recipientUserId,
        toAccountType: row.buzzType as BuzzSpendType,
        amount: row.amount,
        type: TransactionType.Sell,
        description: row.description,
        // Replayed verbatim — see CosmeticShopPayoutDeadLetter.externalTransactionId.
        externalTransactionId: row.externalTransactionId,
        details: { purchasedBy: row.buyerId, originalAmount: row.originalAmount },
      },
    ]);

    // A conflict is the idempotency guard saying this exact payout already moved — the creator has
    // their buzz, so the debt is settled. Anything else means the money did not move.
    const settled = result.transactions.length + result.conflicts.length > 0;
    if (!settled) throw new Error('Buzz service accepted no transaction for this payout');

    await dbWrite.cosmeticShopPayoutDeadLetter.update({
      where: { id: row.id },
      data: { resolvedAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
  } catch (e) {
    const lastError = e instanceof Error ? e.message : String(e);
    const { attempts } = await dbWrite.cosmeticShopPayoutDeadLetter.update({
      where: { id: row.id },
      data: { attempts: { increment: 1 }, lastError },
      select: { attempts: true },
    });

    if (attempts >= MAX_ATTEMPTS) {
      logToAxiom({
        level: 'error',
        message: 'Cosmetic payout dead letter exhausted retries — creator still owed buzz',
        data: {
          id: row.id,
          externalTransactionId: row.externalTransactionId,
          recipientUserId: row.recipientUserId,
          amount: row.amount,
          buzzType: row.buzzType,
          attempts,
          error: lastError,
        },
      });
    }
  }
}

async function publishDeadLetterGauge() {
  const [pending, exhausted] = await Promise.all([
    dbWrite.cosmeticShopPayoutDeadLetter.count({
      where: { resolvedAt: null, attempts: { lt: MAX_ATTEMPTS } },
    }),
    dbWrite.cosmeticShopPayoutDeadLetter.count({
      where: { resolvedAt: null, attempts: { gte: MAX_ATTEMPTS } },
    }),
  ]);

  cosmeticPayoutDeadLetterGauge.set({ state: 'pending' }, pending);
  cosmeticPayoutDeadLetterGauge.set({ state: 'exhausted' }, exhausted);
}
