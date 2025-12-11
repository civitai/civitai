import type { NextApiRequest, NextApiResponse } from 'next';
import { Prisma } from '@prisma/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { dbRead } from '~/server/db/client';
import { deliverMonthlyCosmetics } from '~/server/services/subscriptions.service';

type EligibleUser = {
  userId: number;
  productId: string;
  tier: string;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
};

type MissingCosmetic = {
  id: number;
  name: string;
  productId: string;
  availableStart: Date | null;
  availableEnd: Date | null;
};

/**
 * Backfill membership badges for active subscribers who are missing them.
 *
 * This endpoint solves the issue where users with early renewal dates (e.g., 12/1-12/10)
 * miss monthly badges that are put into circulation after their renewal day has passed.
 *
 * Usage:
 * - GET /api/admin/backfill-membership-badges?token=xxx
 *   Lists all active cosmetics and users missing them (dry run)
 *
 * - GET /api/admin/backfill-membership-badges?token=xxx&cosmeticId=123
 *   Shows users missing a specific cosmetic (dry run)
 *
 * - GET /api/admin/backfill-membership-badges?token=xxx&userId=8180390
 *   Check which cosmetics a specific user is missing
 *
 * - GET /api/admin/backfill-membership-badges?token=xxx&execute=true
 *   Backfills ALL currently active cosmetics to all active subscribers missing them
 *   Uses deliverMonthlyCosmetics() which handles tier-level matching properly
 *
 * - GET /api/admin/backfill-membership-badges?token=xxx&execute=true&userId=8180390
 *   Backfills cosmetics for a specific user only
 */
export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const { cosmeticId, execute, userId } = req.query;

  const shouldExecute = execute === 'true';
  const specificCosmeticId = cosmeticId ? parseInt(String(cosmeticId), 10) : null;
  const specificUserId = userId ? parseInt(String(userId), 10) : null;

  // Find all membership-related cosmetics that are currently active
  const activeCosmetics = await dbRead.$queryRaw<MissingCosmetic[]>`
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
      AND (c."availableEnd" IS NULL OR c."availableEnd" >= NOW())
      ${specificCosmeticId ? Prisma.sql`AND c.id = ${specificCosmeticId}` : Prisma.empty}
    ORDER BY c.id DESC
  `;

  if (activeCosmetics.length === 0) {
    return res.status(404).json({
      success: false,
      message: specificCosmeticId
        ? `Cosmetic with ID ${specificCosmeticId} not found or not active`
        : 'No active membership cosmetics found',
    });
  }

  const missingByCosmetic: Record<number, EligibleUser[]> = {};

  // For each cosmetic, find users who should have it but don't
  for (const cosmetic of activeCosmetics) {
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
      WHERE cs.status = 'active'
        AND cs."currentPeriodEnd" > NOW()
        AND cs."currentPeriodEnd"::date > NOW()::date
        AND pr.provider = 'Civitai'
        AND pr.metadata->>'monthlyBuzz' IS NOT NULL
        -- User's product level must be >= cosmetic's product level
        AND (
          jsonb_typeof(pr.metadata->'level') = 'undefined'
          OR jsonb_typeof(cosmeticProduct.metadata->'level') = 'undefined'
          OR (pr.metadata->>'level')::int >= (cosmeticProduct.metadata->>'level')::int
        )
        -- User's renewal day must have already passed this month
        -- (same logic as deliverMonthlyCosmetics day matching)
        AND (
          -- Exact day match: renewal day <= today's day of month
          EXTRACT(day FROM cs."currentPeriodStart") <= EXTRACT(day FROM NOW())
          OR
          -- Month-end edge case: if their renewal day is > last day of current month,
          -- and today is the last day of the month, they should have received it
          (
            EXTRACT(day FROM cs."currentPeriodStart") > EXTRACT(day FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
            AND EXTRACT(day FROM NOW()) = EXTRACT(day FROM (DATE_TRUNC('month', NOW()) + INTERVAL '1 month' - INTERVAL '1 day'))
          )
        )
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

  // Get all unique user IDs who are missing at least one cosmetic
  const allMissingUserIds = [
    ...new Set(Object.values(missingByCosmetic).flatMap((users) => users.map((u) => u.userId))),
  ];

  // Execute backfill using deliverMonthlyCosmetics if requested
  if (shouldExecute && allMissingUserIds.length > 0) {
    console.log(`Backfilling cosmetics for ${allMissingUserIds.length} users`);
    await deliverMonthlyCosmetics({ userIds: allMissingUserIds });
    console.log(`Backfill complete`);
  }

  // Build summary
  const summary = activeCosmetics.map((cosmetic) => ({
    cosmeticId: cosmetic.id,
    cosmeticName: cosmetic.name,
    productId: cosmetic.productId,
    availableStart: cosmetic.availableStart,
    availableEnd: cosmetic.availableEnd,
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
