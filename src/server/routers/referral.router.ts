import { z } from 'zod';
import { protectedProcedure, router } from '~/server/trpc';
import {
  getReferrerBalance,
  getShopOffers,
  redeemTokens,
} from '~/server/services/referral.service';
import { dbRead, dbWrite } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { TRPCError } from '@trpc/server';
import { ReferralRewardKind, ReferralRewardStatus } from '~/shared/utils/prisma/enums';

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
    const [code, balance, recentRewards, milestones, redemptions, conversionStats] =
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
      ]);

    return {
      code: code.code,
      balance,
      recentRewards,
      milestones,
      redemptions,
      shopItems: constants.referrals.shopItems,
      milestoneLadder: constants.referrals.milestones,
      conversionCount: conversionStats,
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

  trackCheckoutView: protectedProcedure
    .input(z.object({ code: z.string() }))
    .mutation(async ({ input }) => {
      const code = await dbRead.userReferralCode.findUnique({
        where: { code: input.code },
        select: { userId: true, deletedAt: true },
      });
      if (!code || code.deletedAt) return { ok: false };
      const { signalClient } = await import('~/utils/signal-client');
      const { SignalMessages } = await import('~/server/common/enums');
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
