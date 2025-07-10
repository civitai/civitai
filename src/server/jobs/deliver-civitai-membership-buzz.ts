import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';
import dayjs from 'dayjs';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';
import { deliverMonthlyCosmetics } from '../services/subscriptions.service';

export const deliverCivitaiMembershipBuzz = createJob(
  'deliver-civitai-membership-buzz',
  '0 * * * *',
  async () => {
    const now = dayjs();
    const date = now.format('YYYY-MM');

    // Get the current day of the month
    const currentDay = now.date();

    const data = await dbWrite.$queryRaw<
      {
        userId: number;
        buzzAmount: number | string;
        productId: string;
        priceId: string;
        interval: string;
      }[]
    >`
      SELECT 
        "userId",
        pr.metadata->>'monthlyBuzz' as "buzzAmount",
        pr.id as "productId",
        p.id as "priceId",
        p.interval as "interval"
      FROM "CustomerSubscription" cs
      JOIN "Product" pr ON pr.id = cs."productId"
      JOIN "Price" p ON p.id = cs."priceId"
      WHERE (
        -- Exact day match (normal case)
        EXTRACT(day from "currentPeriodStart") = ${currentDay}
        OR
        -- Handle month-end edge cases (e.g., Jan 30th -> Feb 28th, Jan 31st -> Apr 30th)
        (
          EXTRACT(day from "currentPeriodStart") > EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
          AND ${currentDay} = EXTRACT(day from (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
        )
      )
      AND "createdAt" < NOW()::date -- Don't grant on the first day (already granted when membership started)
      AND status = 'active'
      AND "currentPeriodEnd" > NOW()
      AND "currentPeriodEnd"::date > NOW()::date -- Don't grant buzz on the expiration day
      AND pr.provider = 'Civitai'
      AND pr.metadata->>'monthlyBuzz' IS NOT NULL
    `;


    if (!data.length) {
      console.log('No Civitai membership holders found for buzz delivery today');
      return;
    };

    const buzzTransactions = data
      .map((d) => {
        const buzzAmount = Number(d.buzzAmount);

        // For yearly subscriptions, we grant monthly buzz, not the full year amount
        // Monthly subscriptions get their full monthly buzz
        const amount = d.interval === 'year' ? buzzAmount : buzzAmount;

        return {
          fromAccountId: 0,
          toAccountId: d.userId,
          type: TransactionType.Purchase,
          externalTransactionId: `civitai-membership:${date}:${d.userId}:${d.productId}`,
          amount: amount,
          description: `Membership Bonus`,
          details: {
            type: 'civitai-membership-payment',
            date: date,
            productId: d.productId,
            interval: d.interval,
          },
        };
      })
      .filter((d) => d.amount > 0);

    // Process in batches to avoid overwhelming the database
    const batches = chunk(buzzTransactions, 100);
    for (const batch of batches) {
      await createBuzzTransactionMany(batch);
    }

    // Grant cosmetics for Civitai membership holders
    await deliverMonthlyCosmetics({});

    console.log(`Delivered buzz to ${data.length} Civitai membership holders`);
  }
);
