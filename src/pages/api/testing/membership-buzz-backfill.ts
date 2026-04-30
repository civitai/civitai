/**
 * One-time backfill for redeemable-code memberships that missed monthly Buzz deliveries.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN (Bearer header).
 *
 * Usage:
 *   POST /api/testing/membership-buzz-backfill
 *   Authorization: Bearer $WEBHOOK_TOKEN
 *   Content-Type: application/json
 *
 * Body shape:
 *   {
 *     "action": "preview" | "grant",
 *     "items": [
 *       { "subscriptionId": "redeemable-code-MB-XXXX-XXXX", "missing": 1 },
 *       ...
 *     ]
 *   }
 *
 * Actions:
 *   preview  - Validate input, look up each sub, return per-entry plan + per-tier summary. No writes.
 *   grant    - For each entry, append `missing` unlocked PrepaidTokens to the sub's
 *              metadata.tokens, transition status canceled → expired_claimable so
 *              `claimPrepaidToken` will find it, and trigger the unlock-notification email.
 *
 * Token shape per missing month:
 *   { id: 'backfill_{subscriptionId}_m{n}', tier, status: 'unlocked',
 *     buzzAmount, codeId, unlockedAt: now }
 *
 * Idempotency:
 *   Token ids are deterministic, so re-running with the same items skips ids
 *   that already exist (reported in `tokensSkipped`). The user claims via the
 *   normal /user/membership flow, which posts the buzz transaction with a
 *   `prepaid-token-claim:` externalTransactionId.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import { dbWrite } from '~/server/db/client';
import { prepaidTokenUnlockedEmail } from '~/server/email/templates/prepaidTokenUnlocked.email';
import { invalidateSubscriptionCaches, getPrepaidTokens } from '~/server/utils/subscription.utils';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import type { PrepaidToken, SubscriptionMetadata } from '~/server/schema/subscriptions.schema';

const PRODUCT_TIER = {
  'civitai-bronze': 'bronze',
  'civitai-silver': 'silver',
  'civitai-gold': 'gold',
} as const;
type SupportedProductId = keyof typeof PRODUCT_TIER;
type Tier = (typeof PRODUCT_TIER)[SupportedProductId];

const TIER_BUZZ: Record<Tier, number> = {
  bronze: 10_000,
  silver: 25_000,
  gold: 50_000,
};

const itemSchema = z.object({
  subscriptionId: z.string().min(1),
  missing: z.coerce.number().int().positive().max(12),
});

const schema = z.object({
  action: z.enum(['preview', 'grant']),
  items: z.array(itemSchema).min(1).max(2000),
});

type BackfillItem = z.infer<typeof itemSchema>;

type EntryResult = {
  subscriptionId: string;
  userId?: number;
  productId?: string;
  tier?: Tier;
  expectedMissing: number;
  tokensToAdd: number;
  tokensAdded: number;
  tokensSkipped: number;
  totalBuzzAdded: number;
  statusBefore?: string;
  statusAfter?: string;
  emailSent: boolean;
  ok: boolean;
  error?: string;
};

async function loadSubscription(subscriptionId: string) {
  return dbWrite.customerSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      userId: true,
      status: true,
      productId: true,
      metadata: true,
      user: { select: { email: true, username: true } },
    },
  });
}

type LoadedSubscription = NonNullable<Awaited<ReturnType<typeof loadSubscription>>>;
type PlanFailure = { ok: false; result: EntryResult };
type PlanSuccess = {
  ok: true;
  result: EntryResult;
  newTokens: PrepaidToken[];
  sub: LoadedSubscription;
};

function planForItem(
  item: BackfillItem,
  sub: Awaited<ReturnType<typeof loadSubscription>>
): PlanFailure | PlanSuccess {
  const result: EntryResult = {
    subscriptionId: item.subscriptionId,
    expectedMissing: item.missing,
    tokensToAdd: 0,
    tokensAdded: 0,
    tokensSkipped: 0,
    totalBuzzAdded: 0,
    emailSent: false,
    ok: false,
  };

  if (!sub) {
    result.error = 'Subscription not found';
    return { ok: false, result };
  }
  if (!(sub.productId in PRODUCT_TIER)) {
    result.error = `Unsupported productId ${sub.productId} (expected civitai-bronze/silver/gold)`;
    result.userId = sub.userId;
    result.productId = sub.productId;
    return { ok: false, result };
  }

  const productId = sub.productId as SupportedProductId;
  const tier: Tier = PRODUCT_TIER[productId];
  const buzzAmount = TIER_BUZZ[tier];

  result.userId = sub.userId;
  result.productId = productId;
  result.tier = tier;
  result.statusBefore = sub.status ?? undefined;

  const meta = (sub.metadata ?? {}) as SubscriptionMetadata;
  const existingTokens = getPrepaidTokens({ metadata: meta });
  const nowIso = new Date().toISOString();

  const tokensToAdd: PrepaidToken[] = [];
  for (let n = 1; n <= item.missing; n++) {
    const id = `backfill_${item.subscriptionId}_m${n}`;
    if (existingTokens.some((t) => t.id === id)) {
      result.tokensSkipped += 1;
      continue;
    }
    tokensToAdd.push({
      id,
      tier,
      status: 'unlocked',
      buzzAmount,
      codeId: item.subscriptionId.replace('redeemable-code-', ''),
      unlockedAt: nowIso,
    });
  }

  result.tokensToAdd = tokensToAdd.length;
  result.totalBuzzAdded = tokensToAdd.length * buzzAmount;
  result.statusAfter =
    sub.status === 'active' || sub.status === 'expired_claimable'
      ? sub.status
      : 'expired_claimable';

  return { ok: true, result, newTokens: tokensToAdd, sub };
}

async function grantForItem(item: BackfillItem): Promise<EntryResult> {
  try {
    const sub = await loadSubscription(item.subscriptionId);
    const planned = planForItem(item, sub);
    if (!planned.ok) return planned.result;

    const { result, newTokens, sub: loadedSub } = planned;
    if (newTokens.length === 0) {
      result.ok = true;
      return result;
    }

    const meta = (loadedSub.metadata ?? {}) as SubscriptionMetadata;
    const existingTokens = getPrepaidTokens({ metadata: meta });
    const updatedTokens = [...existingTokens, ...newTokens];

    await dbWrite.customerSubscription.update({
      where: { id: loadedSub.id },
      data: {
        metadata: { ...meta, tokens: updatedTokens },
        status: result.statusAfter,
        updatedAt: new Date(),
      },
    });

    result.tokensAdded = newTokens.length;
    await invalidateSubscriptionCaches(loadedSub.userId);

    if (loadedSub.user?.email) {
      try {
        await prepaidTokenUnlockedEmail.send({
          user: {
            email: loadedSub.user.email,
            username: loadedSub.user.username ?? 'there',
          },
          tokensUnlocked: newTokens.length,
          totalBuzz: result.totalBuzzAdded,
        });
        result.emailSent = true;
      } catch (err) {
        result.error = `Email send failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    result.ok = true;
    return result;
  } catch (err) {
    return {
      subscriptionId: item.subscriptionId,
      expectedMissing: item.missing,
      tokensToAdd: 0,
      tokensAdded: 0,
      tokensSkipped: 0,
      totalBuzzAdded: 0,
      emailSent: false,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarize(results: EntryResult[]) {
  const byTier: Record<string, { subs: number; tokens: number; buzz: number }> = {};
  let totalTokens = 0;
  let totalBuzz = 0;
  for (const r of results) {
    const tier = r.tier ?? 'unknown';
    byTier[tier] ??= { subs: 0, tokens: 0, buzz: 0 };
    byTier[tier].subs += 1;
    byTier[tier].tokens += r.tokensToAdd;
    byTier[tier].buzz += r.totalBuzzAdded;
    totalTokens += r.tokensToAdd;
    totalBuzz += r.totalBuzzAdded;
  }
  return { subs: results.length, totalTokens, totalBuzz, byTier };
}

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse(req.body ?? {});
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const { action, items } = payload.data;

  if (action === 'preview') {
    const results: EntryResult[] = [];
    for (const item of items) {
      const sub = await loadSubscription(item.subscriptionId);
      const planned = planForItem(item, sub);
      results.push(planned.result);
    }
    return res.status(200).json({
      action,
      summary: summarize(results),
      entries: results,
    });
  }

  // action === 'grant'
  const results: EntryResult[] = [];
  let tokensAdded = 0;
  let tokensSkipped = 0;
  let totalBuzzAdded = 0;
  let emailsSent = 0;
  let failed = 0;

  for (const item of items) {
    const r = await grantForItem(item);
    results.push(r);
    tokensAdded += r.tokensAdded;
    tokensSkipped += r.tokensSkipped;
    totalBuzzAdded += r.totalBuzzAdded;
    if (r.emailSent) emailsSent += 1;
    if (!r.ok) failed += 1;
  }

  return res.status(200).json({
    action,
    summary: summarize(results),
    tokensAdded,
    tokensSkipped,
    totalBuzzAdded,
    emailsSent,
    failed,
    failures: results.filter((r) => !r.ok || r.error),
  });
});
