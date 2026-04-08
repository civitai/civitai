import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead, dbWrite } from '~/server/db/client';

type EligibleUser = {
  userId: number;
  productId: string;
  tier: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
};

type MembershipCosmetic = {
  id: number;
  name: string;
  productId: string;
  availableStart: Date | null;
  availableEnd: Date | null;
};

/**
 * Backfill membership badges for subscribers who are missing them.
 *
 * Supports both current and past cosmetics. When a cosmeticId is provided,
 * eligibility is checked against the cosmetic's availability window rather
 * than only the current month.
 *
 * Usage:
 * - GET ?token=xxx
 *   Lists all currently active cosmetics and users missing them (dry run)
 *
 * - GET ?token=xxx&cosmeticId=123 or ?cosmeticId=123,456,789
 *   Shows users missing specific cosmetic(s), even if from a past month.
 *   Eligibility is based on whether the user had an active subscription during
 *   the cosmetic's availability window.
 *
 * - GET ?token=xxx&userId=8180390
 *   Check which current cosmetics a specific user is missing
 *
 * - GET ?token=xxx&cosmeticId=123,456&execute=true
 *   Backfills specific cosmetic(s) to all eligible subscribers missing them
 *
 * - GET ?token=xxx&execute=true
 *   Backfills ALL currently active cosmetics to all active subscribers missing them
 *
 * - GET ?token=xxx&execute=true&userId=8180390
 *   Backfills cosmetics for a specific user only
 */
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { cosmeticId, execute, userId } = req.query;

  const shouldExecute = execute === 'true';
  const cosmeticIds = cosmeticId
    ? String(cosmeticId)
        .split(',')
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => !isNaN(id))
    : [];
  const specificUserId = userId ? parseInt(String(userId), 10) : null;

  // When a specific cosmeticId is provided, look it up regardless of date range.
  // Otherwise, only find cosmetics that are currently active.
  const cosmetics = await dbRead.$queryRaw<MembershipCosmetic[]>`
    SELECT DISTINCT
      c.id,
      c.name,
      c."productId",
      c."availableStart",
      c."availableEnd"
    FROM "Cosmetic" c
    JOIN "Product" pr ON pr.id = c."productId"
    WHERE pr.provider = 'Civitai'
      AND pr.metadata->>'monthlyBuzz' IS NOT NULL
      AND (c."availableStart" IS NULL OR c."availableStart" <= NOW())
      ${
        cosmeticIds.length > 0
          ? Prisma.sql`AND c.id IN (${Prisma.join(cosmeticIds)})`
          : Prisma.sql`AND (c."availableEnd" IS NULL OR c."availableEnd" >= NOW())`
      }
    ORDER BY c.id DESC
  `;

  if (cosmetics.length === 0) {
    return res.status(404).json({
      success: false,
      message:
        cosmeticIds.length > 0
          ? `No membership cosmetics found for IDs: ${cosmeticIds.join(', ')}`
          : 'No active membership cosmetics found',
    });
  }

  const missingByCosmetic: Record<number, EligibleUser[]> = {};

  for (const cosmetic of cosmetics) {
    // Determine if this is a past cosmetic (availableEnd is in the past)
    const isPast = cosmetic.availableEnd && cosmetic.availableEnd < new Date();

    // For past cosmetics, check if the user had an active subscription that overlapped
    // the cosmetic's availability window. For current cosmetics, check current subscription.
    const usersWithoutCosmetic = await dbRead.$queryRaw<EligibleUser[]>`
      SELECT
        cs."userId",
        cs."productId",
        pr.metadata->>'tier' as tier,
        cs."currentPeriodStart",
        cs."currentPeriodEnd"
      FROM "CustomerSubscription" cs
      JOIN "Product" pr ON pr.id = cs."productId"
      LEFT JOIN "Product" cosmeticProduct ON cosmeticProduct.id = ${cosmetic.productId}
      WHERE cs.status IN ('active', 'expired_claimable')
        AND pr.provider = 'Civitai'
        AND pr.metadata->>'monthlyBuzz' IS NOT NULL
        -- User's product level must be >= cosmetic's product level
        AND (
          jsonb_typeof(pr.metadata->'level') = 'undefined'
          OR jsonb_typeof(cosmeticProduct.metadata->'level') = 'undefined'
          OR (pr.metadata->>'level')::int >= (cosmeticProduct.metadata->>'level')::int
        )
        ${
          isPast
            ? Prisma.sql`
              -- For past cosmetics: subscription must have been active during the availability window
              AND cs."currentPeriodStart" <= ${cosmetic.availableEnd}
              AND cs."currentPeriodEnd" >= ${cosmetic.availableStart}
            `
            : Prisma.sql`
              -- For current cosmetics: subscription must be currently active
              AND cs."currentPeriodEnd" > NOW()
              AND cs."currentPeriodEnd"::date > NOW()::date
              -- User's renewal day must have already passed this month
              AND (
                EXTRACT(day FROM cs."currentPeriodStart") <= EXTRACT(day FROM NOW())
                OR
                (
                  EXTRACT(day FROM cs."currentPeriodStart") > EXTRACT(day FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
                  AND EXTRACT(day FROM NOW()) = EXTRACT(day FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
                )
              )
            `
        }
        -- User doesn't already have this cosmetic
        AND NOT EXISTS (
          SELECT 1 FROM "UserCosmetic" uc
          WHERE uc."userId" = cs."userId"
            AND uc."cosmeticId" = ${cosmetic.id}
        )
        ${specificUserId ? Prisma.sql`AND cs."userId" = ${specificUserId}` : Prisma.empty}
      ORDER BY cs."userId"
    `;

    missingByCosmetic[cosmetic.id] = usersWithoutCosmetic;
  }

  const allMissingUserIds = [
    ...new Set(Object.values(missingByCosmetic).flatMap((users) => users.map((u) => u.userId))),
  ];

  // Execute backfill by directly inserting UserCosmetic rows.
  // We don't use deliverMonthlyCosmetics here because it checks availability against NOW(),
  // which won't work for past cosmetics.
  if (shouldExecute && allMissingUserIds.length > 0) {
    let totalGranted = 0;
    for (const cosmetic of cosmetics) {
      const users = missingByCosmetic[cosmetic.id] ?? [];
      if (users.length === 0) continue;

      const userIds = users.map((u) => u.userId);
      const result = await dbWrite.$executeRaw`
        INSERT INTO "UserCosmetic" ("userId", "cosmeticId", "obtainedAt", "claimKey")
        SELECT "userId", ${cosmetic.id}, NOW(), 'claimed'
        FROM UNNEST(${userIds}::int[]) AS t("userId")
        ON CONFLICT ("userId", "cosmeticId", "claimKey") DO NOTHING
      `;
      totalGranted += result;
      console.log(`Granted cosmetic ${cosmetic.id} (${cosmetic.name}) to ${result} users`);
    }
    console.log(`Backfill complete: ${totalGranted} total grants`);
  }

  const summary = cosmetics.map((cosmetic) => ({
    cosmeticId: cosmetic.id,
    cosmeticName: cosmetic.name,
    productId: cosmetic.productId,
    availableStart: cosmetic.availableStart,
    availableEnd: cosmetic.availableEnd,
    isPastCosmetic: cosmetic.availableEnd ? cosmetic.availableEnd < new Date() : false,
    usersMissingCount: missingByCosmetic[cosmetic.id]?.length ?? 0,
    usersMissing: specificUserId
      ? missingByCosmetic[cosmetic.id]
      : missingByCosmetic[cosmetic.id]?.map((u) => ({
          userId: u.userId,
          tier: u.tier,
          periodStart: u.currentPeriodStart,
          periodEnd: u.currentPeriodEnd,
        })),
  }));

  const totalMissing = Object.values(missingByCosmetic).reduce(
    (sum, users) => sum + users.length,
    0
  );

  return res.status(200).json({
    success: true,
    dryRun: !shouldExecute,
    message: shouldExecute
      ? `Backfilled cosmetics for ${allMissingUserIds.length} users`
      : `Found ${totalMissing} missing cosmetic grants across ${allMissingUserIds.length} users (use execute=true to apply)`,
    totalUsersAffected: allMissingUserIds.length,
    cosmetics: summary,
  });
});
