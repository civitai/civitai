import { Prisma } from '@prisma/client';
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

export const REFERRAL_SYSTEM_ACCOUNT_ID = -1;
const EXPIRY_WARN_WINDOW_DAYS = 7;
const PRISMA_UNIQUE_VIOLATION = 'P2002';

const REWARD_DESCRIPTIONS: Record<ReferralRewardKind, string> = {
  RefereeBonus: 'Referral bonus for joining via a code',
  BuzzKickback: 'Referral kickback from a referee Buzz purchase',
  MilestoneBonus: 'Referral milestone bonus',
  MembershipToken: 'Referral token (tracked separately, no buzz grant)',
};

function isUniqueViolation(err: unknown) {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === PRISMA_UNIQUE_VIOLATION
  );
}

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

function logFraudEvent(event: Record<string, unknown>) {
  return logToAxiom({ name: 'referral-fraud', ...event }).catch(() => undefined);
}

function tokensForTier(tier: ProductTier): number {
  return constants.referrals.tokensPerTier[tier] ?? 0;
}

function settlementDate(from: Date = new Date()) {
  return dayjs(from).add(constants.referrals.settlementWindowDays, 'day').toDate();
}
function expiryDate(from: Date = new Date()) {
  return dayjs(from).add(constants.referrals.tokenExpiryDays, 'day').toDate();
}

async function resolveReferrerForReferee(refereeId: number) {
  const referral = await dbRead.userReferral.findUnique({
    where: { userId: refereeId },
    select: {
      id: true,
      userReferralCodeId: true,
      firstPaidAt: true,
      paidMonthCount: true,
      userReferralCode: {
        select: {
          userId: true,
          deletedAt: true,
          user: { select: { createdAt: true } },
        },
      },
    },
  });
  if (!referral || !referral.userReferralCode || referral.userReferralCode.deletedAt) return null;
  const referrerId = referral.userReferralCode.userId;
  if (referrerId === refereeId) return null;

  const minAgeDays = constants.referrals.minReferrerAccountAgeDays;
  const referrerCreatedAt = referral.userReferralCode.user?.createdAt;
  if (referrerCreatedAt) {
    const ageDays = dayjs().diff(referrerCreatedAt, 'day');
    if (ageDays < minAgeDays) {
      logFraudEvent({
        type: 'referrer_too_young',
        referrerId,
        refereeId,
        ageDays,
        required: minAgeDays,
      });
      return null;
    }
  }

  return {
    referralId: referral.id,
    referrerId,
    firstPaidAt: referral.firstPaidAt,
    paidMonthCount: referral.paidMonthCount,
  };
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

  const tokenAmount = tokensForTier(tier);
  if (tokenAmount <= 0) return null;

  const now = paidAt ?? new Date();
  const isFirstPayment = ctx.paidMonthCount === 0;

  try {
    const result = await dbWrite.$transaction(async (tx) => {
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

      await tx.userReferral.update({
        where: { id: ctx.referralId },
        data: {
          paidMonthCount: { increment: 1 },
          firstPaidAt: isFirstPayment ? now : undefined,
        },
      });

      if (isFirstPayment && monthlyBuzzAmount > 0) {
        const bonus = Math.floor(monthlyBuzzAmount * constants.referrals.refereeBonusBuzzPct);
        if (bonus > 0) {
          await tx.referralReward.create({
            data: {
              userId: refereeId,
              kind: ReferralRewardKind.RefereeBonus,
              status: ReferralRewardStatus.Pending,
              buzzAmount: bonus,
              tierGranted: tier,
              sourceEventId: `referee-bonus:${sourceEventId}`,
              settledAt: settlementDate(now),
            },
          });
        }
      }

      return reward;
    });

    logFraudEvent({
      type: 'membership_payment',
      refereeId,
      referrerId: ctx.referrerId,
      tier,
      sourceEventId,
      paidMonthCount: ctx.paidMonthCount + 1,
    });

    emitSignal(ctx.referrerId, SignalMessages.ReferralPurchasePending, {
      rewardId: result.id,
      type: 'membership',
      tier,
      tokens: tokenAmount,
      settlesAt: result.settledAt,
    });

    return result.id;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
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

  const now = purchasedAt ?? new Date();

  try {
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

    logFraudEvent({
      type: 'buzz_kickback',
      refereeId,
      referrerId: ctx.referrerId,
      buzzAmount,
      sourceEventId,
    });

    emitSignal(ctx.referrerId, SignalMessages.ReferralPurchasePending, {
      rewardId: reward.id,
      type: 'buzz',
      blueBuzz: kickback,
      settlesAt: reward.settledAt,
    });

    return reward.id;
  } catch (err) {
    if (isUniqueViolation(err)) return null;
    throw err;
  }
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

type SettleableReward = {
  id: number;
  userId: number;
  kind: ReferralRewardKind;
  buzzAmount: number;
  tokenAmount: number;
  refereeId: number | null;
  tierGranted: string | null;
};

async function settleRewardRow(reward: SettleableReward) {
  // Grant buzz first so a failed transaction propagates through the tx and rolls
  // back the status update. The CAS updateMany makes this safe against duplicate
  // runs of the cron — only one caller will see count > 0.
  const claimed = await dbWrite.referralReward.updateMany({
    where: { id: reward.id, status: ReferralRewardStatus.Pending },
    data: { status: ReferralRewardStatus.Settled, settledAt: new Date() },
  });
  if (claimed.count === 0) return;

  if (reward.buzzAmount > 0) {
    try {
      await createBuzzTransaction({
        fromAccountId: REFERRAL_SYSTEM_ACCOUNT_ID,
        fromAccountType: 'blue',
        toAccountId: reward.userId,
        toAccountType: 'blue',
        amount: reward.buzzAmount,
        type: TransactionType.Reward,
        description: REWARD_DESCRIPTIONS[reward.kind],
        externalTransactionId: `referral-reward:${reward.id}`,
      });
    } catch (err) {
      // Buzz grant failed — revert claim so next cron retries.
      await dbWrite.referralReward.update({
        where: { id: reward.id },
        data: { status: ReferralRewardStatus.Pending, revokedReason: String(err) },
      });
      throw err;
    }
  }

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
  const affected = await dbWrite.referralReward.findMany({
    where: {
      OR: [{ sourceEventId }, { sourceEventId: `referee-bonus:${sourceEventId}` }],
      status: { in: [ReferralRewardStatus.Pending, ReferralRewardStatus.Settled] },
    },
    select: { id: true, userId: true, status: true, buzzAmount: true },
  });
  if (!affected.length) return { revoked: 0 };

  for (const reward of affected) {
    if (reward.status === ReferralRewardStatus.Settled && reward.buzzAmount > 0) {
      await createBuzzTransaction({
        fromAccountId: reward.userId,
        fromAccountType: 'blue',
        toAccountId: REFERRAL_SYSTEM_ACCOUNT_ID,
        toAccountType: 'blue',
        amount: reward.buzzAmount,
        type: TransactionType.ChargeBack,
        description: `Referral reward clawback (${reason})`,
        externalTransactionId: `referral-clawback:${reward.id}`,
      }).catch((err) =>
        logToAxiom({
          name: 'referral-clawback',
          type: 'error',
          rewardId: reward.id,
          err: String(err),
        }).catch(() => undefined)
      );
    }
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
  return { revoked: affected.length };
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

  for (const m of constants.referrals.milestones) {
    if (lifetime < m.threshold) continue;
    try {
      await dbWrite.$transaction(async (tx) => {
        await tx.referralMilestone.create({
          data: { userId, threshold: m.threshold, bonusAmount: m.bonus },
        });
        await tx.referralReward.create({
          data: {
            userId,
            kind: ReferralRewardKind.MilestoneBonus,
            status: ReferralRewardStatus.Pending,
            buzzAmount: m.bonus,
            sourceEventId: `milestone:${userId}:${m.threshold}`,
            settledAt: settlementDate(),
          },
        });
      });
      emitSignal(userId, SignalMessages.ReferralMilestone, {
        threshold: m.threshold,
        bonusAmount: m.bonus,
      });
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

export async function expireSettledTokens(now: Date = new Date()) {
  const warnWindow = dayjs(now).add(EXPIRY_WARN_WINDOW_DAYS, 'day').toDate();
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
  const groups = await dbRead.referralReward.groupBy({
    by: ['kind', 'status'],
    where: {
      userId,
      status: {
        in: [
          ReferralRewardStatus.Pending,
          ReferralRewardStatus.Settled,
          ReferralRewardStatus.Redeemed,
        ],
      },
    },
    _sum: { tokenAmount: true, buzzAmount: true },
  });

  let settledTokens = 0;
  let pendingTokens = 0;
  let settledBlueBuzzLifetime = 0;
  let pendingBlueBuzz = 0;

  for (const g of groups) {
    const tokens = g._sum.tokenAmount ?? 0;
    const buzz = g._sum.buzzAmount ?? 0;
    if (g.kind === ReferralRewardKind.MembershipToken) {
      if (g.status === ReferralRewardStatus.Settled) settledTokens += tokens;
      if (g.status === ReferralRewardStatus.Pending) pendingTokens += tokens;
    }
    if (
      g.kind === ReferralRewardKind.BuzzKickback ||
      g.kind === ReferralRewardKind.MilestoneBonus
    ) {
      if (g.status === ReferralRewardStatus.Settled || g.status === ReferralRewardStatus.Redeemed) {
        settledBlueBuzzLifetime += buzz;
      }
      if (g.status === ReferralRewardStatus.Pending) pendingBlueBuzz += buzz;
    }
  }

  return { settledTokens, pendingTokens, settledBlueBuzzLifetime, pendingBlueBuzz };
}

export async function getShopOffers() {
  return constants.referrals.shopItems;
}

async function findReferralProductForTier(tier: string) {
  const products = await dbRead.product.findMany({
    select: { id: true, defaultPriceId: true, metadata: true },
  });
  const match = products.find((p) => {
    const meta = (p.metadata ?? {}) as Record<string, unknown>;
    return meta.tier === tier && meta.referralGrantable === true;
  });
  if (match) return match;
  // Fallback: any Civitai-provider product matching the tier with monthlyBuzz>0 is NOT ideal
  // because it'd hand out buzz — leave strict requirement for referralGrantable flag.
  return null;
}

async function grantReferralSubscription(
  tx: Prisma.TransactionClient,
  userId: number,
  tier: string,
  durationDays: number
) {
  const product = await findReferralProductForTier(tier);
  if (!product || !product.defaultPriceId) {
    logToAxiom({
      name: 'referral-grant-missing-product',
      type: 'error',
      userId,
      tier,
    }).catch(() => undefined);
    throw new Error(
      'Referral tier products are not yet configured. Your tokens have not been spent.'
    );
  }

  const existing = await tx.customerSubscription.findUnique({
    where: { userId_buzzType: { userId, buzzType: 'yellow' } },
    select: { id: true, status: true, currentPeriodEnd: true, metadata: true, productId: true },
  });

  const now = new Date();
  const extension = dayjs(now).add(durationDays, 'day').toDate();

  if (!existing) {
    await tx.customerSubscription.create({
      data: {
        id: `referral:${userId}:${Date.now()}`,
        userId,
        buzzType: 'yellow',
        status: 'active',
        productId: product.id,
        priceId: product.defaultPriceId,
        cancelAtPeriodEnd: true,
        currentPeriodStart: now,
        currentPeriodEnd: extension,
        createdAt: now,
        updatedAt: now,
        metadata: { source: 'referral-redemption' },
      },
    });
    return { created: true };
  }

  if (existing.status !== 'active' || existing.currentPeriodEnd < now) {
    await tx.customerSubscription.update({
      where: { id: existing.id },
      data: {
        status: 'active',
        productId: product.id,
        priceId: product.defaultPriceId,
        currentPeriodStart: now,
        currentPeriodEnd: extension,
        cancelAtPeriodEnd: true,
        metadata: { ...(existing.metadata as object), source: 'referral-redemption' },
      },
    });
    return { reactivated: true };
  }

  throw new Error(
    'You already have an active Membership. Save your tokens for when your membership lapses.'
  );
}

export async function redeemTokens(params: { userId: number; offerIndex: number }) {
  const { userId, offerIndex } = params;
  const offer = constants.referrals.shopItems[offerIndex];
  if (!offer) throw new Error('Invalid shop offer');

  const redemption = await dbWrite.$transaction(async (tx) => {
    // Lock settled token rows so parallel redemptions cannot double-spend.
    const rows = await tx.$queryRaw<{ id: number; tokenAmount: number }[]>(Prisma.sql`
      SELECT id, "tokenAmount"
      FROM "ReferralReward"
      WHERE "userId" = ${userId}
        AND kind = ${ReferralRewardKind.MembershipToken}::"ReferralRewardKind"
        AND status = ${ReferralRewardStatus.Settled}::"ReferralRewardStatus"
      ORDER BY "expiresAt" ASC NULLS LAST, id ASC
      FOR UPDATE
    `);

    let remaining = offer.cost;
    const fullyConsumed: number[] = [];
    let partial: { id: number; newAmount: number } | null = null;
    for (const row of rows) {
      if (remaining <= 0) break;
      if (row.tokenAmount <= remaining) {
        fullyConsumed.push(row.id);
        remaining -= row.tokenAmount;
      } else {
        partial = { id: row.id, newAmount: row.tokenAmount - remaining };
        remaining = 0;
      }
    }
    if (remaining > 0) throw new Error('Insufficient tokens');

    // Grant first — if it throws (e.g. user already has active sub, products missing),
    // the whole tx rolls back and tokens are NOT consumed.
    await grantReferralSubscription(tx, userId, offer.tier, offer.durationDays);

    if (fullyConsumed.length) {
      await tx.referralReward.updateMany({
        where: { id: { in: fullyConsumed } },
        data: { status: ReferralRewardStatus.Redeemed, redeemedAt: new Date() },
      });
    }
    if (partial) {
      await tx.referralReward.update({
        where: { id: partial.id },
        data: { tokenAmount: partial.newAmount, redeemedAt: new Date() },
      });
    }

    return tx.referralRedemption.create({
      data: {
        userId,
        tokensSpent: offer.cost,
        tier: offer.tier,
        durationDays: offer.durationDays,
        subscriptionId: `referral:${userId}:${offer.tier}`,
      },
      select: { id: true, tier: true, durationDays: true, createdAt: true, tokensSpent: true },
    });
  });

  emitSignal(userId, SignalMessages.ReferralTierGranted, {
    redemptionId: redemption.id,
    tier: offer.tier,
    durationDays: offer.durationDays,
  });

  return redemption;
}
