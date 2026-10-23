import { createJob, getJobDate } from './job';
import { dbWrite } from '~/server/db/client';
import type { RemovedUserCosmetic } from '~/server/redis/caches';
import { refreshUserCosmeticCacheForRemoved, wornUserIds } from '~/server/redis/caches';
import { queueWornCosmeticsUpdate } from '~/server/search-index/users.search-index';

export async function deliverMembershipCosmetics({
  now,
  lastDelivered,
}: {
  now: Date;
  lastDelivered: Date;
}) {
  await dbWrite.$executeRaw`
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
        AND cs."currentPeriodStart" <= ${now}::timestamp
        AND cs."currentPeriodEnd" >= ${now}::timestamp
    ),
    subscription_tiers AS (
      SELECT
        s."userId",
        COALESCE(pdl.id, s."productId") as "productId",
        pd.provider,
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
      ${now}::timestamp,
      'claimed'
    FROM subscription_tiers s
    JOIN "Cosmetic" c ON
      c."productId" = s."productId"
      AND (
        -- Undated (the Supporter Nameplate): held for as long as the membership is. Civitai
        -- members get these from deliverMonthlyCosmetics, which gives Buzz-purchased
        -- memberships dated badges only; the level join here would map those onto
        -- civitai-bronze.
        (c."availableStart" IS NULL AND c.source = 'Membership' AND s.provider <> 'Civitai')
        OR (
          -- Compare the period start, not job time: a late-paid September period is still owed
          -- September's badge. Civitai keeps the current-month limit because prepaid periods
          -- can start long before the month being delivered.
          (s.provider <> 'Civitai' OR c."availableStart" >= date_trunc('month', ${lastDelivered}::timestamp))
          -- Date granularity: availableStart carries a time of day, so a timestamp compare
          -- misses a renewal earlier that day (e.g. 00:30 on the 1st).
          AND s."currentPeriodStart"::date >= c."availableStart"::date
        )
      )
      AND (c."availableEnd" IS NULL OR s."currentPeriodStart"::date <= c."availableEnd"::date)
    ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING;
  `;

  await dbWrite.$executeRaw`
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
      AND cs."currentPeriodStart" <= ${now}::timestamp
      AND cs."currentPeriodEnd" >= ${now}::timestamp
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

  const revoked = await dbWrite.$queryRaw<RemovedUserCosmetic[]>`
    -- Revoke member limited cosmetics
    WITH to_revoke AS (
      SELECT
      "userId"
      FROM "CustomerSubscription" cs
      WHERE "cancelAt" <= ${lastDelivered}
        -- An old canceled subscription must not strip a member who is subscribed today,
        -- including one whose renewal payment is still being retried.
        AND NOT EXISTS (
          SELECT 1
          FROM "CustomerSubscription" acs
          WHERE acs."userId" = cs."userId"
            AND acs.status IN ('active', 'trialing', 'past_due')
            AND acs."currentPeriodEnd" >= ${now}::timestamp
        )
    )
    DELETE FROM "UserCosmetic" uc
    WHERE EXISTS (
      SELECT 1
      FROM to_revoke r
      JOIN "Cosmetic" c ON c.id = uc."cosmeticId"
      WHERE r."userId" = uc."userId"
      AND c."permanentUnlock" = false
      AND c.source = 'Membership'
    )
    RETURNING uc."userId", uc."equippedAt", uc."equippedToId";
  `;
  await refreshUserCosmeticCacheForRemoved(revoked);
  await queueWornCosmeticsUpdate(wornUserIds(revoked));
}

export const deliverPurchasedCosmetics = createJob(
  'deliver-purchased-cosmetics',
  '0 23 * * *',
  async () => {
    const [lastDelivered, setLastDelivered] = await getJobDate('last-cosmetic-delivery');
    await deliverMembershipCosmetics({ now: new Date(), lastDelivered });
    await setLastDelivered();
  }
);
