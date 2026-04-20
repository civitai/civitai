import type { Prisma } from '@prisma/client';
import { ReferralRewardKind, ReferralRewardStatus } from '~/shared/utils/prisma/enums';
import dayjs from 'dayjs';
import { dbRead, dbWrite } from '~/server/db/client';
import { constants } from '~/server/common/constants';
import { SignalMessages } from '~/server/common/enums';
import { signalClient } from '~/utils/signal-client';
import { TransactionType } from '~/shared/constants/buzz.constants';
import { createBuzzTransaction } from '~/server/services/buzz.service';
import type { ProductTier } from '~/server/schema/subscriptions.schema';
import { logToAxiom } from '~/server/logging/client';

const REFERRAL_SYSTEM_ACCOUNT_ID = -1;

function emitSignal(userId: number, target: SignalMessages, data: Record<string, unknown>) {
  return signalClient.send({ userId, target, data }).catch((err) =>
    logToAxiom({
      name: 'referral-signal',
      type: 'error',
      target,
      userId,
      err: String(err),
    }).catch(() => undefined)
  );
}

function tokensForTier(tier: ProductTier): number {
  return constants.referrals.tokensPerTier[tier] ?? 0;
}

async function resolveReferrerForReferee(refereeId: number) {
  const referral = await dbRead.userReferral.findUnique({
    where: { userId: refereeId },
    select: {
      id: true,
      userReferralCodeId: true,
      firstPaidAt: true,
      paidMonthCount: true,
      userReferralCode: { select: { userId: true, deletedAt: true } },
    },
  });
  if (!referral || !referral.userReferralCode || referral.userReferralCode.deletedAt) return null;
  const referrerId = referral.userReferralCode.userId;
  if (referrerId === refereeId) return null;
  return {
    referralId: referral.id,
    referrerId,
    firstPaidAt: referral.firstPaidAt,
    paidMonthCount: referral.paidMonthCount,
  };
}

function settlementDate(from: Date = new Date()) {
  return dayjs(from).add(constants.referrals.settlementWindowDays, 'day').toDate();
}
function expiryDate(from: Date = new Date()) {
  return dayjs(from).add(constants.referrals.tokenExpiryDays, 'day').toDate();
}

export async function bindReferralCodeForUser(userId: number, code: string) {
  const referralCode = await dbRead.userReferralCode.findFirst({
    where: { code, deletedAt: null },
  });
  if (!referralCode || referralCode.userId === userId) return null;

  const existing = await dbRead.userReferral.findUnique({ where: { userId } });
  if (existing && existing.userReferralCodeId === referralCode.id) return existing;
  if (existing && !existing.userReferralCodeId) {
    return dbWrite.userReferral.update({
      where: { id: existing.id },
      data: { userReferralCodeId: referralCode.id },
    });
  }
  if (!existing) {
    return dbWrite.userReferral.create({
      data: { userId, userReferralCodeId: referralCode.id },
    });
  }
  return existing;
}

function logFraudEvent(event: Record<string, unknown>) {
  return logToAxiom({ name: 'referral-fraud', ...event }).catch(() => undefined);
}

export async function recordMembershipPaymentReward(params: {
  refereeId: number;
  tier: ProductTier;
  monthlyBuzzAmount: number;
  sourceEventId: string;
  paidAt?: Date;
}) {
  const { refereeId, tier, monthlyBuzzAmount, sourceEventId, paidAt } = params;
  const ctx = await resolveReferrerForReferee(refereeId);
  if (!ctx) return null;
  if (ctx.paidMonthCount >= constants.referrals.maxPaidMonthsPerReferee) return null;

  logFraudEvent({
    type: 'membership_payment',
    refereeId,
    referrerId: ctx.referrerId,
    tier,
    sourceEventId,
    paidMonthCount: ctx.paidMonthCount + 1,
  });

  const tokenAmount = tokensForTier(tier);
  if (tokenAmount <= 0) return null;

  const existing = await dbRead.referralReward.findFirst({
    where: { sourceEventId, kind: ReferralRewardKind.MembershipToken },
    select: { id: true },
  });
  if (existing) return existing.id;

  const now = paidAt ?? new Date();
  const isFirstPayment = ctx.paidMonthCount === 0;

  return dbWrite.$transaction(async (tx) => {
    await tx.userReferral.update({
      where: { id: ctx.referralId },
      data: {
        paidMonthCount: { increment: 1 },
        firstPaidAt: isFirstPayment ? now : undefined,
      },
    });

    const reward = await tx.referralReward.create({
      data: {
        userId: ctx.referrerId,
        refereeId,
        kind: ReferralRewardKind.MembershipToken,
        status: ReferralRewardStatus.Pending,
        tokenAmount,
        tierGranted: tier,
        sourceEventId,
        earnedAt: now,
        settledAt: settlementDate(now),
        expiresAt: expiryDate(now),
      },
    });

    if (isFirstPayment) {
      await grantRefereeBonus({ tx, refereeId, tier, monthlyBuzzAmount, sourceEventId });
    }

    emitSignal(ctx.referrerId, SignalMessages.ReferralPurchasePending, {
      rewardId: reward.id,
      type: 'membership',
      tier,
      tokens: tokenAmount,
      settlesAt: reward.settledAt,
    });

    return reward.id;
  });
}

async function grantRefereeBonus(params: {
  tx: Prisma.TransactionClient;
  refereeId: number;
  tier: ProductTier;
  monthlyBuzzAmount: number;
  sourceEventId: string;
}) {
  const { tx, refereeId, tier, monthlyBuzzAmount, sourceEventId } = params;
  const bonus = Math.floor(monthlyBuzzAmount * constants.referrals.refereeBonusBuzzPct);
  if (bonus <= 0) return;

  await tx.referralReward.create({
    data: {
      userId: refereeId,
      kind: ReferralRewardKind.RefereeBonus,
      status: ReferralRewardStatus.Pending,
      buzzAmount: bonus,
      tierGranted: tier,
      sourceEventId: `referee-bonus:${sourceEventId}`,
      settledAt: settlementDate(),
    },
  });
}

export async function recordBuzzPurchaseKickback(params: {
  refereeId: number;
  buzzAmount: number;
  sourceEventId: string;
  purchasedAt?: Date;
}) {
  const { refereeId, buzzAmount, sourceEventId, purchasedAt } = params;
  if (buzzAmount <= 0) return null;

  const ctx = await resolveReferrerForReferee(refereeId);
  if (!ctx) return null;
  if (!ctx.firstPaidAt) return null;

  const kickback = Math.floor(buzzAmount * constants.referrals.buzzKickbackPct);
  if (kickback <= 0) return null;

  const existing = await dbRead.referralReward.findFirst({
    where: { sourceEventId, kind: ReferralRewardKind.BuzzKickback },
    select: { id: true },
  });
  if (existing) return existing.id;

  logFraudEvent({
    type: 'buzz_kickback',
    refereeId,
    referrerId: ctx.referrerId,
    buzzAmount,
    sourceEventId,
  });

  const now = purchasedAt ?? new Date();
  const reward = await dbWrite.referralReward.create({
    data: {
      userId: ctx.referrerId,
      refereeId,
      kind: ReferralRewardKind.BuzzKickback,
      status: ReferralRewardStatus.Pending,
      buzzAmount: kickback,
      sourceEventId,
      earnedAt: now,
      settledAt: settlementDate(now),
    },
  });

  emitSignal(ctx.referrerId, SignalMessages.ReferralPurchasePending, {
    rewardId: reward.id,
    type: 'buzz',
    blueBuzz: kickback,
    settlesAt: reward.settledAt,
  });

  return reward.id;
}

export async function settleDueRewards(now: Date = new Date()) {
  const due = await dbWrite.referralReward.findMany({
    where: { status: ReferralRewardStatus.Pending, settledAt: { lte: now } },
    orderBy: { id: 'asc' },
    take: 500,
  });
  if (!due.length) return { settled: 0 };

  let settledCount = 0;
  for (const reward of due) {
    try {
      await settleRewardRow(reward);
      settledCount++;
    } catch (err) {
      await logToAxiom({
        name: 'referral-settle',
        type: 'error',
        rewardId: reward.id,
        err: String(err),
      }).catch(() => undefined);
    }
  }
  return { settled: settledCount };
}

async function settleRewardRow(reward: {
  id: number;
  userId: number;
  kind: ReferralRewardKind;
  buzzAmount: number;
  tokenAmount: number;
  refereeId: number | null;
  tierGranted: string | null;
}) {
  await dbWrite.$transaction(async (tx) => {
    const updated = await tx.referralReward.updateMany({
      where: { id: reward.id, status: ReferralRewardStatus.Pending },
      data: { status: ReferralRewardStatus.Settled },
    });
    if (updated.count === 0) return;

    if (reward.buzzAmount > 0) {
      await createBuzzTransaction({
        fromAccountId: REFERRAL_SYSTEM_ACCOUNT_ID,
        fromAccountType: 'blue',
        toAccountId: reward.userId,
        toAccountType: 'blue',
        amount: reward.buzzAmount,
        type: TransactionType.Reward,
        description:
          reward.kind === ReferralRewardKind.RefereeBonus
            ? 'Referral bonus for joining via a code'
            : reward.kind === ReferralRewardKind.BuzzKickback
            ? 'Referral kickback from a referee Buzz purchase'
            : 'Referral milestone bonus',
        externalTransactionId: `referral-reward:${reward.id}`,
      }).catch(async (err) => {
        await tx.referralReward.update({
          where: { id: reward.id },
          data: { status: ReferralRewardStatus.Pending, revokedReason: String(err) },
        });
        throw err;
      });
    }
  });

  if (reward.kind !== ReferralRewardKind.RefereeBonus) {
    emitSignal(reward.userId, SignalMessages.ReferralSettled, {
      rewardId: reward.id,
      type: reward.kind === ReferralRewardKind.MembershipToken ? 'membership' : 'buzz',
      tokens: reward.tokenAmount || undefined,
      blueBuzz: reward.buzzAmount || undefined,
    });
  }

  if (reward.buzzAmount > 0 && reward.kind === ReferralRewardKind.BuzzKickback) {
    await awardMilestones(reward.userId).catch(() => undefined);
  }
}

export async function revokeForChargeback(params: { sourceEventId: string; reason: string }) {
  const { sourceEventId, reason } = params;
  const rewards = await dbWrite.referralReward.findMany({
    where: {
      OR: [{ sourceEventId }, { sourceEventId: `referee-bonus:${sourceEventId}` }],
      status: ReferralRewardStatus.Pending,
    },
  });
  if (!rewards.length) return { revoked: 0 };

  for (const reward of rewards) {
    await dbWrite.referralReward.update({
      where: { id: reward.id },
      data: {
        status: ReferralRewardStatus.Revoked,
        revokedAt: new Date(),
        revokedReason: reason,
      },
    });
    emitSignal(reward.userId, SignalMessages.ReferralClawback, {
      rewardId: reward.id,
      reason,
    });
  }
  return { revoked: rewards.length };
}

export async function awardMilestones(userId: number) {
  const agg = await dbRead.referralReward.aggregate({
    where: {
      userId,
      kind: ReferralRewardKind.BuzzKickback,
      status: { in: [ReferralRewardStatus.Settled, ReferralRewardStatus.Redeemed] },
    },
    _sum: { buzzAmount: true },
  });
  const lifetime = agg._sum.buzzAmount ?? 0;
  if (lifetime <= 0) return;

  const already = await dbRead.referralMilestone.findMany({
    where: { userId },
    select: { threshold: true },
  });
  const seen = new Set(already.map((m) => m.threshold));

  for (const m of constants.referrals.milestones) {
    if (lifetime < m.threshold || seen.has(m.threshold)) continue;
    await dbWrite.$transaction(async (tx) => {
      const created = await tx.referralMilestone.create({
        data: { userId, threshold: m.threshold, bonusAmount: m.bonus },
      });
      await tx.referralReward.create({
        data: {
          userId,
          kind: ReferralRewardKind.MilestoneBonus,
          status: ReferralRewardStatus.Pending,
          buzzAmount: m.bonus,
          sourceEventId: `milestone:${created.id}`,
          settledAt: settlementDate(),
        },
      });
    });
    emitSignal(userId, SignalMessages.ReferralMilestone, {
      threshold: m.threshold,
      bonusAmount: m.bonus,
    });
  }
}

export async function expireSettledTokens(now: Date = new Date()) {
  const warnWindow = dayjs(now).add(7, 'day').toDate();
  const expiringSoon = await dbRead.referralReward.groupBy({
    by: ['userId'],
    where: {
      kind: ReferralRewardKind.MembershipToken,
      status: ReferralRewardStatus.Settled,
      expiresAt: { lte: warnWindow, gt: now },
    },
    _sum: { tokenAmount: true },
    _min: { expiresAt: true },
  });
  for (const row of expiringSoon) {
    emitSignal(row.userId, SignalMessages.ReferralTokenExpiringSoon, {
      tokens: row._sum.tokenAmount ?? 0,
      expiresAt: row._min.expiresAt,
    });
  }

  const { count } = await dbWrite.referralReward.updateMany({
    where: {
      kind: ReferralRewardKind.MembershipToken,
      status: ReferralRewardStatus.Settled,
      expiresAt: { lte: now },
    },
    data: { status: ReferralRewardStatus.Expired },
  });
  return { expired: count };
}

export async function getReferrerBalance(userId: number) {
  const [settledTokensAgg, pendingTokensAgg, blueBuzzSettledAgg, blueBuzzPendingAgg] =
    await Promise.all([
      dbRead.referralReward.aggregate({
        where: {
          userId,
          kind: ReferralRewardKind.MembershipToken,
          status: ReferralRewardStatus.Settled,
        },
        _sum: { tokenAmount: true },
      }),
      dbRead.referralReward.aggregate({
        where: {
          userId,
          kind: ReferralRewardKind.MembershipToken,
          status: ReferralRewardStatus.Pending,
        },
        _sum: { tokenAmount: true },
      }),
      dbRead.referralReward.aggregate({
        where: {
          userId,
          kind: { in: [ReferralRewardKind.BuzzKickback, ReferralRewardKind.MilestoneBonus] },
          status: ReferralRewardStatus.Settled,
        },
        _sum: { buzzAmount: true },
      }),
      dbRead.referralReward.aggregate({
        where: {
          userId,
          kind: { in: [ReferralRewardKind.BuzzKickback, ReferralRewardKind.MilestoneBonus] },
          status: ReferralRewardStatus.Pending,
        },
        _sum: { buzzAmount: true },
      }),
    ]);

  return {
    settledTokens: settledTokensAgg._sum.tokenAmount ?? 0,
    pendingTokens: pendingTokensAgg._sum.tokenAmount ?? 0,
    settledBlueBuzzLifetime: blueBuzzSettledAgg._sum.buzzAmount ?? 0,
    pendingBlueBuzz: blueBuzzPendingAgg._sum.buzzAmount ?? 0,
  };
}

export async function getShopOffers() {
  return constants.referrals.shopItems;
}

export async function redeemTokens(params: { userId: number; offerIndex: number }) {
  const { userId, offerIndex } = params;
  const offer = constants.referrals.shopItems[offerIndex];
  if (!offer) throw new Error('Invalid shop offer');

  return dbWrite.$transaction(async (tx) => {
    const settled = await tx.referralReward.findMany({
      where: {
        userId,
        kind: ReferralRewardKind.MembershipToken,
        status: ReferralRewardStatus.Settled,
      },
      orderBy: { expiresAt: 'asc' },
    });

    let remaining = offer.cost;
    const toConsume: { id: number; consume: number; available: number }[] = [];
    for (const row of settled) {
      if (remaining <= 0) break;
      const take = Math.min(row.tokenAmount, remaining);
      toConsume.push({ id: row.id, consume: take, available: row.tokenAmount });
      remaining -= take;
    }
    if (remaining > 0) throw new Error('Insufficient tokens');

    for (const entry of toConsume) {
      if (entry.consume === entry.available) {
        await tx.referralReward.update({
          where: { id: entry.id },
          data: { status: ReferralRewardStatus.Redeemed, redeemedAt: new Date() },
        });
      } else {
        await tx.referralReward.update({
          where: { id: entry.id },
          data: { tokenAmount: entry.available - entry.consume },
        });
      }
    }

    const redemption = await tx.referralRedemption.create({
      data: {
        userId,
        tokensSpent: offer.cost,
        tier: offer.tier,
        durationDays: offer.durationDays,
      },
    });

    emitSignal(userId, SignalMessages.ReferralTierGranted, {
      redemptionId: redemption.id,
      tier: offer.tier,
      durationDays: offer.durationDays,
    });

    return redemption;
  });
}
