import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';

export const deliverPurchasedCosmetics = createJob(
  'deliver-purchased-cosmetics',
  '0 23 * * *',
  async () => {
    const [lastDelivered, setLastDelivered] = await getJobDate('last-cosmetic-delivery');

    const deliverSubscriptionCosmetics = async () =>
      dbWrite.$executeRaw`
        -- Deliver subscription cosmetics
        WITH active_subscriptions AS (
          SELECT
            cs."userId",
            cs."productId",
            cs."currentPeriodStart",
            cs."currentPeriodEnd",
            cs."createdAt"
          FROM "CustomerSubscription" cs
          JOIN "Product" pd ON pd.id = cs."productId"
          WHERE cs.status = 'active'
            AND cs."currentPeriodStart" <= now()
            AND cs."currentPeriodEnd" >= now()
        ),
        subscription_tiers AS (
          SELECT
            s."userId",
            COALESCE(pdl.id, s."productId") as "productId",
            s."currentPeriodStart",
            s."currentPeriodEnd",
            s."createdAt"
          FROM active_subscriptions s
          JOIN "Product" pd ON pd.id = s."productId"
          LEFT JOIN "Product" pdl
            ON pdl.active
              AND jsonb_typeof(pd.metadata->'level') != 'undefined'
              AND jsonb_typeof(pdl.metadata->'level') != 'undefined'
              AND (pdl.metadata->>'level')::int <= (pd.metadata->>'level')::int
              AND pdl.provider = pd.provider
        )
        INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "claimKey")
        SELECT DISTINCT
          s."userId",
          c.id "cosmeticId",
          now(),
          'claimed'
        FROM subscription_tiers s
        JOIN "Cosmetic" c ON
          c."productId" = s."productId"
          AND c."availableStart" >= date_trunc('month', ${lastDelivered}::timestamp)
          -- Compare at date granularity: membership badges are authored with an 11:00 UTC
          -- availableStart, so a period that started earlier that same day (e.g. a Stripe
          -- renewal at 00:30 on the 1st) failed a timestamp comparison forever — this join
          -- re-runs daily but currentPeriodStart never moves within the period.
          AND (c."availableStart" IS NULL OR s."currentPeriodStart"::date >= c."availableStart"::date)
          AND (c."availableEnd" IS NULL OR s."currentPeriodStart"::date <= c."availableEnd"::date)
        ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
    `;

    const deliverSupporterUpgradeCosmetic = async () =>
      dbWrite.$executeRaw`
        -- Deliver supporter upgrade cosmetic
        INSERT INTO "UserCosmetic"("userId", "cosmeticId", "claimKey")
        SELECT
          cs."userId",
          c.id as "cosmeticId",
          'claimed'
        FROM "CustomerSubscription" cs
        JOIN "Product" pd ON pd.id = cs."productId"
        JOIN "Cosmetic" c ON c.name = 'Grandfather Badge'
        WHERE cs.status = 'active'
          AND cs."currentPeriodStart" <= now()
          AND cs."currentPeriodEnd" >= now()
          AND jsonb_typeof(pd.metadata->'level') != 'undefined'
          AND EXISTS (
            SELECT 1
            FROM "CustomerSubscription" ocs
            JOIN "Product" opd ON opd.id = ocs."productId"
            WHERE opd.metadata->>'tier' = 'founder'
              AND ocs."userId" = cs."userId"
              AND ocs.status = 'active'
          )
        ON CONFLICT DO NOTHING;
      `;

    const revokeMembershipLimitedCosmetics = async () =>
      dbWrite.$executeRaw`
        -- Revoke member limited cosmetics
        WITH to_revoke AS (
          SELECT
          "userId"
          FROM "CustomerSubscription" cs
          WHERE "cancelAt" <= ${lastDelivered}
        )
        DELETE FROM "UserCosmetic" uc
        WHERE EXISTS (
          SELECT 1
          FROM to_revoke r
          JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
          WHERE r."userId" = uc."userId"
          AND c."permanentUnlock" = false
          AND c.source = 'Membership'
        );
      `;

    // Deliver cosmetics
    // --------------------------------------------
    await deliverSubscriptionCosmetics();
    await deliverSupporterUpgradeCosmetic();
    await revokeMembershipLimitedCosmetics();

    // Update the last time this ran in the KeyValue store
    // --------------------------------------------
    await setLastDelivered();
  }
);
