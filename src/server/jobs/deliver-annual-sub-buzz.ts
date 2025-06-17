import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';
import dayjs from 'dayjs';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';

export const deliverAnnualSubscriptionBuzz = createJob(
  'deliver-annual-subscription-buzz',
  '0 * * * *',
  async () => {
    const date = dayjs().format('YYYY-MM');
    const data = await dbWrite.$queryRaw<
      { userId: number; buzzAmount: number | string; productId: string }[]
    >`
      SELECT 
        "userId",
        pr.metadata->>'monthlyBuzz' as buzzAmount,
        pr.id as "productId"
      FROM "CustomerSubscription" cs
      JOIN "Product" pr ON pr.id = cs."productId"
      JOIN "Price" p ON p.id =  cs."priceId" 
      WHERE EXTRACT(day from NOW()) = EXTRACT(day from "currentPeriodStart")
        AND "createdAt" <= NOW() - INTERVAL '1 month'
        AND status = 'active'
        AND "currentPeriodEnd" > NOW()
        AND p."interval" = 'year'
        AND pr.metadata->>'monthlyBuzz' IS NOT NULL
    `;

    if (!data.length) return;

    const buzzTransactions = data.map((d) => {
      return {
        fromAccountId: 0,
        toAccountId: d.userId,
        type: TransactionType.Purchase,
        externalTransactionId: `annual-sub-payment-${date}:${d.userId}:${d.productId}`,
        amount: Number(d.buzzAmount) ?? 3000, // assume a min of 3000.
        description: `Membership bonus`,
        details: {
          type: 'annual-subscription-payment',
          date: date,
          productId: d.productId,
        },
      };
    });

    const batches = chunk(buzzTransactions, 100);
    for (const batch of batches) {
      await createBuzzTransactionMany(batch);
    }
  }
);
