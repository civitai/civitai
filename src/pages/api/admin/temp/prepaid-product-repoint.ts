/**
 * One-time backfill for memberships pointed at a non-canonical tier product.
 * =============================================================================
 *
 * Mod-only admin route. Requires an authenticated moderator session.
 *
 * The prepaid rollover cron used to resolve a tier to whichever product the planner
 * returned last, so paying members were moved onto the Buzz-purchase variant of their own
 * tier — same badge and limits, but `rewardsMultiplier` / `purchasesMultiplier` reset to 1.
 * The cron is fixed and re-points these rows on their next rollover; this route corrects
 * them now instead of up to a month from now.
 *
 * Usage:
 *   POST /api/admin/temp/prepaid-product-repoint
 *   Content-Type: application/json
 *
 * Body shape:
 *   { "action": "preview" | "apply", "subscriptionIds": ["sub_x", ...] }
 *
 * Actions:
 *   preview - Report every affected row and the product it would move to. No writes.
 *   apply   - Re-point productId/priceId to the canonical tier product and bust the
 *             user's subscription caches (multipliers, session, vault).
 *
 * `subscriptionIds` is optional; omit it to sweep every affected row. Rows whose
 * `buzzType` is a kind-discriminator ('buzzPurchase' / 'referral') belong on the variant
 * product and are never touched.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import { invalidateSubscriptionCaches } from '~/server/utils/subscription.utils';
import { isCanonicalTierProduct } from '~/shared/utils/buzz-membership';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

const PAID_TIERS = ['bronze', 'silver', 'gold'];

// `CustomerSubscription.buzzType` is a Buzz colour for ordinary rows and a subscription-kind
// discriminator for these two. A row carrying one of them is genuinely a Buzz-purchase or
// referral membership and belongs on the variant product.
const VARIANT_SUBSCRIPTION_TYPES = ['buzzPurchase', 'referral'];

const schema = z.object({
  action: z.enum(['preview', 'apply']),
  subscriptionIds: z.array(z.string().min(1)).min(1).max(2000).optional(),
});

type EntryResult = {
  subscriptionId: string;
  userId: number;
  status: string | null;
  buzzType: string | null;
  tier: string;
  fromProductId: string;
  toProductId: string;
  toPriceId: string;
  applied: boolean;
  error?: string;
};

export default ModEndpoint(
  async function (req: NextApiRequest, res: NextApiResponse) {
    const payload = schema.safeParse(req.body ?? {});
    if (!payload.success) {
      return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
    }
    const { action, subscriptionIds } = payload.data;

    const products = await dbWrite.product.findMany({
      where: { provider: 'Civitai' },
      include: {
        prices: { where: { active: true, interval: 'month' }, take: 1, orderBy: { id: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });

    const canonicalByTier = new Map<string, (typeof products)[0]>();
    const variantProductTiers = new Map<string, string>();
    for (const product of products) {
      const meta = product.metadata as SubscriptionProductMetadata;
      if (!meta?.tier || !PAID_TIERS.includes(meta.tier)) continue;

      if (!isCanonicalTierProduct(product.metadata)) {
        variantProductTiers.set(product.id, meta.tier);
        continue;
      }
      if (!canonicalByTier.has(meta.tier)) canonicalByTier.set(meta.tier, product);
    }

    const missingCanonical = [...new Set(variantProductTiers.values())].filter((tier) => {
      const canonical = canonicalByTier.get(tier);
      return !canonical || !canonical.prices.length;
    });

    const subscriptions = await dbWrite.customerSubscription.findMany({
      where: {
        productId: { in: [...variantProductTiers.keys()] },
        status: { in: ['active', 'trialing', 'expired_claimable'] },
        ...(subscriptionIds ? { id: { in: subscriptionIds } } : {}),
      },
      select: { id: true, userId: true, status: true, buzzType: true, productId: true },
    });

    const entries: EntryResult[] = [];
    const skipped: Array<{ subscriptionId: string; reason: string }> = [];

    for (const sub of subscriptions) {
      if (sub.buzzType && VARIANT_SUBSCRIPTION_TYPES.includes(sub.buzzType)) {
        skipped.push({ subscriptionId: sub.id, reason: `buzzType ${sub.buzzType}` });
        continue;
      }

      const tier = variantProductTiers.get(sub.productId);
      const canonical = tier ? canonicalByTier.get(tier) : undefined;
      if (!tier || !canonical || !canonical.prices.length) {
        skipped.push({
          subscriptionId: sub.id,
          reason: `no canonical product with an active monthly price for tier ${tier ?? 'unknown'}`,
        });
        continue;
      }

      entries.push({
        subscriptionId: sub.id,
        userId: sub.userId,
        status: sub.status,
        buzzType: sub.buzzType,
        tier,
        fromProductId: sub.productId,
        toProductId: canonical.id,
        toPriceId: canonical.prices[0].id,
        applied: false,
      });
    }

    if (action === 'apply') {
      for (const entry of entries) {
        try {
          await dbWrite.customerSubscription.update({
            where: { id: entry.subscriptionId },
            data: {
              productId: entry.toProductId,
              priceId: entry.toPriceId,
              updatedAt: new Date(),
            },
          });
          entry.applied = true;
          await invalidateSubscriptionCaches(entry.userId);
        } catch (err) {
          entry.error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    return res.status(200).json({
      action,
      summary: {
        variantProducts: [...variantProductTiers.keys()],
        missingCanonical,
        candidates: subscriptions.length,
        affected: entries.length,
        applied: entries.filter((e) => e.applied).length,
        failed: entries.filter((e) => e.error).length,
        skipped: skipped.length,
      },
      entries,
      skipped,
    });
  },
  ['POST']
);
