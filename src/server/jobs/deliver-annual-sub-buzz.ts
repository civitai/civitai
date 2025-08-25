import { chunk } from 'lodash-es';
import { dbWrite } from '~/server/db/client';
import { createJob } from './job';
import dayjs from '~/shared/utils/dayjs';
import { TransactionType } from '~/server/schema/buzz.schema';
import { createBuzzTransactionMany } from '~/server/services/buzz.service';

export const deliverAnnualSubscriptionBuzz = createJob(
  'deliver-annual-subscription-buzz',
  '0 * * * *',
  async () => {
    const date = dayjs().format('YYYY-MM');
    const data = await dbWrite.$queryRaw<
      { userId: number; buzzAmount: number | string; productId: string; priceId: string }[]
    >`
      SELECT
        "userId",
        pr.metadata->>'monthlyBuzz' as "buzzAmount",
        pr.id as "productId",
        p.id as "priceId"
      FROM "CustomerSubscription" cs
      JOIN "Product" pr ON pr.id = cs."productId"
      JOIN "Price" p ON p.id =  cs."priceId"
      WHERE EXTRACT(day from NOW()) = EXTRACT(day from "currentPeriodStart")
        AND "createdAt" <= NOW() - INTERVAL '1 month'
        AND status = 'active'
        AND "currentPeriodEnd"::date > NOW()::date
        AND p."interval" = 'year'
        AND pr.metadata->>'monthlyBuzz' IS NOT NULL
    `;

    if (!data.length) return;

    const buzzTransactions = data
      .map((d) => {
        return {
          fromAccountId: 0,
          toAccountId: d.userId,
          type: TransactionType.Purchase,
          externalTransactionId: `annual-sub-payment-${date}:${d.userId}:${d.productId}`,
          amount: Number(d.buzzAmount), // assume a min of 3000.
          description: `Membership bonus`,
          details: {
            type: 'annual-subscription-payment',
            date: date,
            productId: d.productId,
          },
        };
      })
      .filter((d) => d.amount > 0);

    const batches = chunk(buzzTransactions, 100);
    for (const batch of batches) {
      await createBuzzTransactionMany(batch);
    }

    // Mark this as purchases to ensure these guys receive their cosmetics.
    await dbWrite.$executeRaw`
      with users_affected AS (
        SELECT
          "userId",
          COALESCE(pdl.id, pr.id) "productId",
          NOW() as "createdAt"
        FROM "CustomerSubscription" cs
        JOIN "Product" pr ON pr.id = cs."productId"
        JOIN "Price" p ON p.id =  cs."priceId"
        LEFT JOIN "Product" pdl
          ON pdl.active
            AND jsonb_typeof(pr.metadata->'level') != 'undefined'
            AND jsonb_typeof(pdl.metadata->'level') != 'undefined'
            AND (pdl.metadata->>'level')::int <= (pr.metadata->>'level')::int
            AND pdl.provider = pr.provider
        WHERE EXTRACT(day from NOW()) = EXTRACT(day from "currentPeriodStart")
          AND "createdAt" <= NOW() - INTERVAL '1 month'
          AND status = 'active'
          AND "currentPeriodEnd"::date > NOW()::date
          AND p."interval" = 'year'
          AND pr.metadata->>'monthlyBuzz' IS NOT NULL
      )
      INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "claimKey")
      SELECT DISTINCT
        p."userId",
        c.id "cosmeticId",
        now(),
        'claimed'
      FROM users_affected p
      JOIN "Cosmetic" c ON
        c."productId" = p."productId"
        AND (c."availableStart" IS NULL OR p."createdAt" >= c."availableStart")
        AND (c."availableEnd" IS NULL OR p."createdAt" <= c."availableEnd")
      ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
    `;
  }
);
