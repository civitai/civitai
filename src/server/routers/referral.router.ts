import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '~/server/trpc';
import {
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
    const [code, balance, recentRewards, milestones, redemptions, conversionStats, referralSub] =
      await Promise.all([
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
      ]);

    const activeTier = (
      (referralSub?.product?.metadata ?? null) as {
        tier?: string;
      } | null
    )?.tier;
    const referralQueue =
      (referralSub?.metadata as { referralQueue?: { tier: string; durationDays: number }[] } | null)
        ?.referralQueue ?? [];

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
    const byTier: Record<string, number> = {};
    for (const p of products) {
      const meta = (p.metadata ?? {}) as SubscriptionProductMetadata;
      if (!meta.tier || !meta.monthlyBuzz) continue;
      const existing = byTier[meta.tier];
      if (!existing || meta.monthlyBuzz > existing) byTier[meta.tier] = meta.monthlyBuzz;
    }
    return { monthlyBuzzByTier: byTier, refereeBonusPct: constants.referrals.refereeBonusBuzzPct };
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
