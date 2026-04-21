/**
 * Debug endpoint for the Referral Program v2.
 * =============================================================================
 *
 * Hidden testing route. Guarded by the WEBHOOK_TOKEN via `?token=` query
 * param (not Bearer header — see TokenSecuredEndpoint). Not reachable
 * without the secret; no public UI.
 *
 * Usage:
 *   POST /api/testing/referrals?token=$WEBHOOK_TOKEN
 *   Content-Type: application/json
 *   Body: { "action": "<action>", ...params }
 *
 * Actions (see the switch below for authoritative param list):
 *   dump                          - {userId}                                   Full referral state snapshot
 *   bind-code                     - {userId, code}                             Bind a referral code to a user's UserReferral
 *   grant-tokens                  - {userId, tier, tokens, settleImmediately?} Insert a MembershipToken reward
 *   grant-blue-buzz               - {userId, blueBuzz, settleImmediately?}     Insert a BuzzKickback reward
 *   enqueue-chunk                 - {userId, tier, durationDays}               Push a chunk onto the referral-sub queue
 *   simulate-membership-payment   - {refereeId, tier, monthlyBuzz?}            Fires recordMembershipPaymentReward
 *   simulate-buzz-purchase        - {refereeId, blueBuzz}                      Fires recordBuzzPurchaseKickback (blueBuzz here = yellow amount spent)
 *   simulate-chargeback           - {sourceEventId}                            Fires revokeForChargeback
 *   settle-all                    - {userId?}                                  Fast-forward Pending rewards, run settle cron
 *   advance-subs                  - {userId?}                                  Expire referral sub, run advance cron (promotes next queue chunk)
 *   expire-tokens                 - {userId}                                   Expire all settled tokens for the user
 *   reset                         - {userId, confirm: true}                    Wipe all referral data for one user
 *
 * Flow: grant-tokens (settleImmediately=true) -> visit /user/referrals ->
 * redeem -> enqueue-chunk -> advance-subs -> reset.
 *
 * Permanent changes are scoped to a single userId/refereeId per call so a
 * misuse never cascades across the DB.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import * as z from 'zod';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import {
  advanceReferralSubscriptions,
  bindReferralCodeForUser,
  expireSettledTokens,
  getReferrerBalance,
  recordBuzzPurchaseKickback,
  recordMembershipPaymentReward,
  revokeForChargeback,
  settleDueRewards,
} from '~/server/services/referral.service';
import { ReferralRewardKind, ReferralRewardStatus } from '~/shared/utils/prisma/enums';
import { Prisma } from '@prisma/client';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';

// Hidden debug endpoint for experimenting with the referral program.
// Guarded by the WEBHOOK_TOKEN header — not reachable by end users.
// Every destructive action is narrowly scoped to a single userId so a
// misuse can't cascade across the DB.

const actionSchema = z.enum([
  'dump',
  'bind-code',
  'grant-tokens',
  'grant-blue-buzz',
  'enqueue-chunk',
  'simulate-membership-payment',
  'simulate-buzz-purchase',
  'simulate-chargeback',
  'settle-all',
  'advance-subs',
  'expire-tokens',
  'reset',
]);

const schema = z
  .object({
    action: actionSchema,
    userId: z.coerce.number().int().positive().optional(),
    refereeId: z.coerce.number().int().positive().optional(),
    tier: z.enum(['bronze', 'silver', 'gold']).optional(),
    tokens: z.coerce.number().int().positive().optional(),
    blueBuzz: z.coerce.number().int().positive().optional(),
    monthlyBuzz: z.coerce.number().int().nonnegative().optional(),
    durationDays: z.coerce.number().int().positive().optional(),
    sourceEventId: z.string().optional(),
    code: z.string().optional(),
    settleImmediately: z.coerce.boolean().optional(),
    confirm: z.coerce.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const needsUser: z.infer<typeof actionSchema>[] = [
      'dump',
      'bind-code',
      'grant-tokens',
      'grant-blue-buzz',
      'enqueue-chunk',
      'simulate-membership-payment',
      'simulate-buzz-purchase',
      'expire-tokens',
      'reset',
    ];
    if (needsUser.includes(data.action) && !data.userId) {
      ctx.addIssue({ code: 'custom', message: `${data.action} requires userId`, path: ['userId'] });
    }
    if (data.action === 'bind-code' && !data.code) {
      ctx.addIssue({ code: 'custom', message: 'bind-code requires code', path: ['code'] });
    }
    if (data.action === 'grant-tokens' && (!data.tier || !data.tokens)) {
      ctx.addIssue({ code: 'custom', message: 'grant-tokens requires tier + tokens' });
    }
    if (data.action === 'grant-blue-buzz' && !data.blueBuzz) {
      ctx.addIssue({ code: 'custom', message: 'grant-blue-buzz requires blueBuzz' });
    }
    if (data.action === 'simulate-membership-payment' && (!data.tier || !data.refereeId)) {
      ctx.addIssue({ code: 'custom', message: 'simulate-membership-payment requires tier + refereeId' });
    }
    if (data.action === 'simulate-buzz-purchase' && (!data.refereeId || !data.blueBuzz)) {
      ctx.addIssue({ code: 'custom', message: 'simulate-buzz-purchase requires refereeId + blueBuzz (the yellow amount spent)' });
    }
    if (data.action === 'simulate-chargeback' && !data.sourceEventId) {
      ctx.addIssue({ code: 'custom', message: 'simulate-chargeback requires sourceEventId' });
    }
    if (data.action === 'enqueue-chunk' && (!data.tier || !data.durationDays)) {
      ctx.addIssue({ code: 'custom', message: 'enqueue-chunk requires tier + durationDays' });
    }
    if (data.action === 'reset' && !data.confirm) {
      ctx.addIssue({ code: 'custom', message: 'reset requires confirm=true' });
    }
  });

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const payload = schema.safeParse({ ...req.query, ...(req.body ?? {}) });
  if (!payload.success) {
    return res.status(400).json({ error: 'Invalid request', issues: payload.error.issues });
  }
  const input = payload.data;
  const now = new Date();

  switch (input.action) {
    case 'dump': {
      const userId = input.userId!;
      const [code, referralRow, rewards, milestones, redemptions, attributions, sub, balance] =
        await Promise.all([
          dbRead.userReferralCode.findFirst({ where: { userId, deletedAt: null } }),
          dbRead.userReferral.findUnique({
            where: { userId },
            include: { userReferralCode: { select: { id: true, code: true, userId: true } } },
          }),
          dbRead.referralReward.findMany({
            where: { userId },
            orderBy: { earnedAt: 'desc' },
            take: 50,
          }),
          dbRead.referralMilestone.findMany({ where: { userId } }),
          dbRead.referralRedemption.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 25,
          }),
          dbRead.referralAttribution.findMany({
            where: { OR: [{ refereeId: userId }, { referralCode: { userId } }] },
            orderBy: { createdAt: 'desc' },
            take: 25,
          }),
          dbRead.customerSubscription.findUnique({
            where: { userId_buzzType: { userId, buzzType: 'referral' } },
            include: { product: { select: { id: true, metadata: true } } },
          }),
          getReferrerBalance(userId),
        ]);
      return res.status(200).json({
        userId,
        code,
        referralRow,
        rewards,
        milestones,
        redemptions,
        attributions,
        referralSub: sub,
        balance,
      });
    }

    case 'bind-code': {
      const result = await bindReferralCodeForUser(input.userId!, input.code!);
      return res.status(200).json({ action: input.action, result });
    }

    case 'grant-tokens': {
      const sourceEventId = input.sourceEventId ?? `debug-grant:${Date.now()}`;
      const reward = await dbWrite.referralReward.create({
        data: {
          userId: input.userId!,
          kind: ReferralRewardKind.MembershipToken,
          status: input.settleImmediately
            ? ReferralRewardStatus.Settled
            : ReferralRewardStatus.Pending,
          tokenAmount: input.tokens!,
          tierGranted: input.tier,
          sourceEventId,
          earnedAt: now,
          settledAt: input.settleImmediately ? now : dayjs(now).add(7, 'day').toDate(),
          expiresAt: dayjs(now).add(90, 'day').toDate(),
        },
      });
      return res.status(200).json({ action: input.action, reward });
    }

    case 'grant-blue-buzz': {
      const sourceEventId = input.sourceEventId ?? `debug-bb:${Date.now()}`;
      const reward = await dbWrite.referralReward.create({
        data: {
          userId: input.userId!,
          kind: ReferralRewardKind.BuzzKickback,
          status: input.settleImmediately
            ? ReferralRewardStatus.Settled
            : ReferralRewardStatus.Pending,
          buzzAmount: input.blueBuzz!,
          sourceEventId,
          earnedAt: now,
          settledAt: input.settleImmediately ? now : dayjs(now).add(7, 'day').toDate(),
        },
      });
      return res.status(200).json({
        action: input.action,
        reward,
        note: 'If settleImmediately=true, run settle-all to actually credit Blue Buzz to the user account.',
      });
    }

    case 'enqueue-chunk': {
      const sub = await dbWrite.customerSubscription.findUnique({
        where: { userId_buzzType: { userId: input.userId!, buzzType: 'referral' } },
      });
      if (!sub) {
        return res
          .status(404)
          .json({ error: 'No referral subscription for user. Redeem tokens first.' });
      }
      const meta = (sub.metadata as {
        referralQueue?: { tier: string; durationDays: number }[];
      } | null) ?? {};
      const queue = [...(meta.referralQueue ?? [])];
      queue.push({ tier: input.tier!, durationDays: input.durationDays! });
      await dbWrite.customerSubscription.update({
        where: { id: sub.id },
        data: {
          metadata: { ...meta, referralQueue: queue } as Prisma.InputJsonValue,
        },
      });
      return res.status(200).json({ action: input.action, queue });
    }

    case 'simulate-membership-payment': {
      const monthlyBuzz = input.monthlyBuzz ?? { bronze: 10_000, silver: 25_000, gold: 50_000 }[input.tier!];
      const sourceEventId = input.sourceEventId ?? `debug-invoice:${Date.now()}`;
      const result = await recordMembershipPaymentReward({
        refereeId: input.refereeId!,
        tier: input.tier!,
        monthlyBuzzAmount: monthlyBuzz,
        sourceEventId,
      });
      return res.status(200).json({ action: input.action, rewardId: result, sourceEventId });
    }

    case 'simulate-buzz-purchase': {
      const sourceEventId = input.sourceEventId ?? `debug-pi:${Date.now()}`;
      const result = await recordBuzzPurchaseKickback({
        refereeId: input.refereeId!,
        buzzAmount: input.blueBuzz!, // reused field; callers pass the yellow buzz purchase amount
        sourceEventId,
      });
      return res.status(200).json({ action: input.action, rewardId: result, sourceEventId });
    }

    case 'simulate-chargeback': {
      const result = await revokeForChargeback({
        sourceEventId: input.sourceEventId!,
        reason: 'debug-chargeback',
      });
      return res.status(200).json({ action: input.action, ...result });
    }

    case 'settle-all': {
      // Fast-forward any Pending rewards by shifting their settledAt into the past,
      // then run the cron. Scoped to a specific user when userId is provided.
      if (input.userId) {
        await dbWrite.referralReward.updateMany({
          where: { userId: input.userId, status: ReferralRewardStatus.Pending },
          data: { settledAt: dayjs(now).subtract(1, 'minute').toDate() },
        });
      }
      const result = await settleDueRewards();
      return res.status(200).json({ action: input.action, ...result });
    }

    case 'advance-subs': {
      // Fast-forward user's referral sub to expired, then advance.
      if (input.userId) {
        await dbWrite.customerSubscription.updateMany({
          where: { userId: input.userId, buzzType: 'referral' },
          data: { currentPeriodEnd: dayjs(now).subtract(1, 'minute').toDate() },
        });
      }
      const result = await advanceReferralSubscriptions();
      return res.status(200).json({ action: input.action, ...result });
    }

    case 'expire-tokens': {
      await dbWrite.referralReward.updateMany({
        where: {
          userId: input.userId!,
          kind: ReferralRewardKind.MembershipToken,
          status: ReferralRewardStatus.Settled,
        },
        data: { expiresAt: dayjs(now).subtract(1, 'minute').toDate() },
      });
      const result = await expireSettledTokens();
      return res.status(200).json({ action: input.action, ...result });
    }

    case 'reset': {
      const userId = input.userId!;
      const sub = await dbWrite.customerSubscription.findUnique({
        where: { userId_buzzType: { userId, buzzType: 'referral' } },
        select: { id: true },
      });

      const deletedRewards = await dbWrite.referralReward.deleteMany({
        where: { OR: [{ userId }, { refereeId: userId }] },
      });
      const deletedMilestones = await dbWrite.referralMilestone.deleteMany({ where: { userId } });
      const deletedRedemptions = await dbWrite.referralRedemption.deleteMany({ where: { userId } });
      const deletedAttributions = await dbWrite.referralAttribution.deleteMany({
        where: { OR: [{ refereeId: userId }, { referralCode: { userId } }] },
      });
      const referralReset = await dbWrite.userReferral.updateMany({
        where: { userId },
        data: { firstPaidAt: null, paidMonthCount: 0 },
      });

      let subDeleted = 0;
      if (sub) {
        await dbWrite.customerSubscription.delete({ where: { id: sub.id } });
        subDeleted = 1;
      }

      return res.status(200).json({
        action: input.action,
        deletedRewards: deletedRewards.count,
        deletedMilestones: deletedMilestones.count,
        deletedRedemptions: deletedRedemptions.count,
        deletedAttributions: deletedAttributions.count,
        referralRowReset: referralReset.count,
        referralSubDeleted: subDeleted,
      });
    }
  }

  return res.status(400).json({ error: 'Unhandled action' });
});
