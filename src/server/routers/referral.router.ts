import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
  awardMilestones,
  getReferrerBalance,
  getShopOffers,
  redeemTokens,
} from '~/server/services/referral.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { ReferralRewardKind, ReferralRewardStatus } from '~/shared/utils/prisma/enums';
import { signalClient } from '~/utils/signal-client';
import { SignalMessages } from '~/server/common/enums';
import type { SubscriptionProductMetadata } from '~/server/schema/subscriptions.schema';

const redeemInput = z.object({ offerIndex: z.number().int().min(0) });

async function getOrCreateCode(userId: number) {
  let code = await dbRead.userReferralCode.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
  if (!code) {
    code = await dbWrite.userReferralCode.create({
      data: {
        userId,
        code: generateCode(),
      },
    });
  }
  return code;
}

function generateCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export const referralRouter = router({
  getDashboard: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.user.id;
    // Fire-and-forget: backfill any milestones the user has earned but that
    // weren't written yet (e.g. after the points-rebalance). awardMilestones
    // is idempotent via a unique (userId, threshold) constraint.
    awardMilestones(userId).catch(() => undefined);
    const [
      code,
      balance,
      recentRewards,
      milestones,
      redemptions,
      conversionStats,
      referralSub,
      paidMembership,
    ] = await Promise.all([
      getOrCreateCode(userId),
      getReferrerBalance(userId),
      dbRead.referralReward.findMany({
        where: {
          userId,
          kind: { in: [ReferralRewardKind.MembershipToken, ReferralRewardKind.BuzzKickback] },
          status: { in: [ReferralRewardStatus.Pending, ReferralRewardStatus.Settled] },
        },
        orderBy: { earnedAt: 'desc' },
        take: 25,
        select: {
          id: true,
          kind: true,
          status: true,
          tokenAmount: true,
          buzzAmount: true,
          tierGranted: true,
          earnedAt: true,
          settledAt: true,
          expiresAt: true,
        },
      }),
      dbRead.referralMilestone.findMany({ where: { userId }, orderBy: { threshold: 'asc' } }),
      dbRead.referralRedemption.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      dbRead.userReferral.count({
        where: {
          userReferralCode: { userId },
          firstPaidAt: { not: null },
        },
      }),
      dbRead.customerSubscription.findFirst({
        where: { userId, buzzType: 'referral' },
        select: {
          status: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          metadata: true,
          product: { select: { metadata: true } },
        },
      }),
      dbRead.customerSubscription.findFirst({
        where: { userId, status: 'active', buzzType: { not: 'referral' } },
        select: {
          currentPeriodEnd: true,
          product: { select: { metadata: true } },
        },
      }),
    ]);

    const activeTier = (
      (referralSub?.product?.metadata ?? null) as {
        tier?: string;
      } | null
    )?.tier;
    const referralQueue =
      (referralSub?.metadata as { referralQueue?: { tier: string; durationDays: number }[] } | null)
        ?.referralQueue ?? [];

    const paidMembershipTier = (
      (paidMembership?.product?.metadata ?? null) as { tier?: string } | null
    )?.tier;

    return {
      code: code.code,
      balance,
      recentRewards,
      milestones,
      redemptions,
      shopItems: constants.referrals.shopItems,
      milestoneLadder: constants.referrals.milestones,
      conversionCount: conversionStats,
      referralGrant:
        referralSub && activeTier && referralSub.status === 'active'
          ? {
              activeTier,
              currentPeriodStart: referralSub.currentPeriodStart,
              currentPeriodEnd: referralSub.currentPeriodEnd,
              queue: referralQueue,
            }
          : null,
      activeMembership:
        paidMembershipTier && paidMembership
          ? {
              tier: paidMembershipTier,
              currentPeriodEnd: paidMembership.currentPeriodEnd,
            }
          : null,
    };
  }),

  redeem: protectedProcedure.input(redeemInput).mutation(async ({ ctx, input }) => {
    try {
      return await redeemTokens({ userId: ctx.user.id, offerIndex: input.offerIndex });
    } catch (err) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: (err as Error).message });
    }
  }),

  getShopOffers: protectedProcedure.query(async () => {
    return getShopOffers();
  }),

  getTierBonuses: publicProcedure.query(async () => {
    const products = await dbRead.product.findMany({ select: { metadata: true } });
    const monthlyBuzzByTier: Record<string, number> = {};
    const rewardsMultiplierByTier: Record<string, number> = {};
    const purchasesMultiplierByTier: Record<string, number> = {};
    for (const p of products) {
      const meta = (p.metadata ?? {}) as SubscriptionProductMetadata;
      if (!meta.tier) continue;
      // Skip referral-grantable placeholder products (monthlyBuzz=0) so we reflect
      // real tier perks users would get if they bought the membership.
      if (meta.referralGrantable) continue;
      if (meta.monthlyBuzz) {
        const existing = monthlyBuzzByTier[meta.tier];
        if (!existing || meta.monthlyBuzz > existing)
          monthlyBuzzByTier[meta.tier] = meta.monthlyBuzz;
      }
      // Coerce — product metadata is loose JSON; multipliers occasionally
      // come back as strings depending on how they were written.
      const rewardsMultiplier = Number(meta.rewardsMultiplier);
      const purchasesMultiplier = Number(meta.purchasesMultiplier);
      if (Number.isFinite(rewardsMultiplier) && rewardsMultiplier > 1) {
        const existing = rewardsMultiplierByTier[meta.tier];
        if (!existing || rewardsMultiplier > existing)
          rewardsMultiplierByTier[meta.tier] = rewardsMultiplier;
      }
      if (Number.isFinite(purchasesMultiplier) && purchasesMultiplier > 1) {
        const existing = purchasesMultiplierByTier[meta.tier];
        if (!existing || purchasesMultiplier > existing)
          purchasesMultiplierByTier[meta.tier] = purchasesMultiplier;
      }
    }
    return {
      monthlyBuzzByTier,
      rewardsMultiplierByTier,
      purchasesMultiplierByTier,
      refereeBonusPct: constants.referrals.refereeBonusBuzzPct,
    };
  }),

  trackCheckoutView: publicProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ input }) => {
      const code = await dbRead.userReferralCode.findUnique({
        where: { code: input.code },
        select: { userId: true, deletedAt: true },
      });
      if (!code || code.deletedAt) return { ok: false };
      await signalClient
        .send({
          userId: code.userId,
          target: SignalMessages.ReferralCheckoutViewed,
          data: { anonymous: true, at: new Date().toISOString() },
        })
        .catch(() => null);
      return { ok: true };
    }),
});
