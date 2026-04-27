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
// Distinct CustomerSubscription.buzzType so referral grants stack with paid
// yellow/green/blue subscriptions without tripping @@unique([userId, buzzType]).
const REFERRAL_BUZZ_TYPE = 'referral';
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

type AttributionPayment = {
  paymentProvider?: string;
  stripePaymentIntentId?: string;
  stripeInvoiceId?: string;
  stripeChargeId?: string;
  paymentMethodFingerprint?: string;
  ipAddress?: string;
};

async function recordAttribution(params: {
  referralCodeId?: number | null;
  refereeId: number;
  eventType: string;
  sourceEventId?: string;
  tier?: string;
  amount?: number;
  metadata?: Record<string, unknown>;
  payment?: AttributionPayment;
}) {
  const { referralCodeId, refereeId, eventType, sourceEventId, tier, amount, metadata, payment } =
    params;
  if (!referralCodeId) return;
  try {
    await dbWrite.referralAttribution.create({
      data: {
        referralCodeId,
        refereeId,
        eventType,
        sourceEventId: sourceEventId ?? null,
        tier: tier ?? null,
        amount: amount ?? null,
        paymentProvider: payment?.paymentProvider ?? null,
        stripePaymentIntentId: payment?.stripePaymentIntentId ?? null,
        stripeInvoiceId: payment?.stripeInvoiceId ?? null,
        stripeChargeId: payment?.stripeChargeId ?? null,
        paymentMethodFingerprint: payment?.paymentMethodFingerprint ?? null,
        ipAddress: payment?.ipAddress ?? null,
        metadata: (metadata ?? {}) as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    // Attribution logging is best-effort — never block core reward flow on it.
    await logToAxiom({
      name: 'referral-attribution-write-failed',
      err: String(err),
      refereeId,
      eventType,
    }).catch(() => undefined);
  }
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
  // Read against the primary, not the replica. This is called immediately
  // after `bindReferralCodeForUser` writes the UserReferral row inside the
  // invoice.paid handler — the replica may not have caught up yet, and a
  // null read here silently aborts the entire reward path (incident 4/27).
  const select = {
    id: true,
    userReferralCodeId: true,
    firstPaidAt: true,
    paidMonthCount: true,
    userReferralCode: {
      select: {
        id: true,
        userId: true,
        deletedAt: true,
        user: { select: { createdAt: true } },
      },
    },
  } as const;
  const referral = await dbWrite.userReferral.findUnique({
    where: { userId: refereeId },
    select,
  });
  if (!referral || !referral.userReferralCode || referral.userReferralCode.deletedAt) return null;
  const referrerId = referral.userReferralCode.userId;
  if (referrerId === refereeId) return null;

  const minAgeDays = constants.referrals.minReferrerAccountAgeDays;
  const referrerCreatedAt = referral.userReferralCode.user?.createdAt;
  if (referrerCreatedAt) {
    const ageDays = dayjs().diff(referrerCreatedAt, 'day');
    if (ageDays < minAgeDays) {
      await recordAttribution({
        referralCodeId: referral.userReferralCode.id,
        refereeId,
        eventType: 'referrer_too_young',
        metadata: { referrerId, ageDays, required: minAgeDays },
      });
      return null;
    }
  }

  return {
    referralId: referral.id,
    referralCodeId: referral.userReferralCode.id,
    referrerId,
    firstPaidAt: referral.firstPaidAt,
    paidMonthCount: referral.paidMonthCount,
  };
}

export async function bindReferralCodeForUser(userId: number, code: string) {
  // Both reads against the primary. Two concurrent invoice.paid retries can
  // race here, and a stale replica read leads to either silent skip (when the
  // existing row is missed downstream) or a unique-violation crash on the
  // create path below (UserReferral has unique on userId).
  const referralCode = await dbWrite.userReferralCode.findFirst({
    where: { code, deletedAt: null },
  });
  if (!referralCode || referralCode.userId === userId) return null;

  const existing = await dbWrite.userReferral.findUnique({ where: { userId } });
  if (existing && existing.userReferralCodeId === referralCode.id) return existing;
  if (existing && !existing.userReferralCodeId) {
    return dbWrite.userReferral.update({
      where: { id: existing.id },
      data: { userReferralCodeId: referralCode.id },
    });
  }
  if (!existing) {
    try {
      return await dbWrite.userReferral.create({
        data: { userId, userReferralCodeId: referralCode.id },
      });
    } catch (err) {
      // Belt-and-suspenders: if a parallel call snuck a row in between our
      // existing-check and the create, the unique(userId) constraint trips.
      // Re-read and return that row instead of bubbling P2002 up to the
      // webhook handler.
      if (isUniqueViolation(err)) {
        return dbWrite.userReferral.findUnique({ where: { userId } });
      }
      throw err;
    }
  }
  return existing;
}

export async function recordMembershipPaymentReward(params: {
  refereeId: number;
  tier: ProductTier;
  monthlyBuzzAmount: number;
  sourceEventId: string;
  paidAt?: Date;
  payment?: AttributionPayment;
}) {
  const { refereeId, tier, monthlyBuzzAmount, sourceEventId, paidAt, payment } = params;
  const ctx = await resolveReferrerForReferee(refereeId);
  if (!ctx) {
    // Surface so we can spot replica-lag races, missing-referral-row bugs, or
    // referrers dropping out of the eligibility window. Silent return null was
    // exactly the failure mode we missed in the 4/27 incident.
    logToAxiom({
      name: 'referral-membership-no-context',
      type: 'warn',
      refereeId,
      tier,
      sourceEventId,
    }).catch(() => undefined);
    return null;
  }
  if (ctx.paidMonthCount >= constants.referrals.maxPaidMonthsPerReferee) {
    await recordAttribution({
      referralCodeId: ctx.referralCodeId,
      refereeId,
      eventType: 'membership_payment_over_cap',
      sourceEventId,
      tier,
      metadata: { paidMonthCount: ctx.paidMonthCount },
      payment,
    });
    return null;
  }

  const tokenAmount = tokensForTier(tier);
  if (tokenAmount <= 0) {
    // Tier should always map; if it doesn't, our constants drifted from a
    // product's metadata — log loudly so we don't quietly drop rewards.
    logToAxiom({
      name: 'referral-membership-zero-tokens',
      type: 'warn',
      refereeId,
      tier,
      sourceEventId,
    }).catch(() => undefined);
    return null;
  }

  const now = paidAt ?? new Date();

  // Snapshot the tier's point value at write time so re-tuning the constants
  // later doesn't retroactively re-evaluate historical rewards.
  const tierPoints = constants.referrals.pointsPerTierMonth[tier] ?? 0;

  try {
    const { reward: result, refereeBonusReward } = await dbWrite.$transaction(async (tx) => {
      // Lock the UserReferral row inside the tx and re-read paidMonthCount /
      // firstPaidAt before incrementing. Two concurrent invoice.paid webhooks
      // (e.g. Stripe retries with different invoice IDs) would otherwise both
      // see paidMonthCount=0, both create a RefereeBonus, and both increment.
      const locked = await tx.$queryRaw<
        { paidMonthCount: number; firstPaidAt: Date | null }[]
      >(Prisma.sql`
        SELECT "paidMonthCount", "firstPaidAt"
        FROM "UserReferral"
        WHERE id = ${ctx.referralId}
        FOR UPDATE
      `);
      const lockedRow = locked[0];
      if (!lockedRow) throw new Error('UserReferral row vanished mid-tx');
      if (lockedRow.paidMonthCount >= constants.referrals.maxPaidMonthsPerReferee) {
        throw Object.assign(new Error('over-cap-after-lock'), { __overCap: true });
      }
      const lockedIsFirstPayment = lockedRow.paidMonthCount === 0 && !lockedRow.firstPaidAt;

      const reward = await tx.referralReward.create({
        data: {
          userId: ctx.referrerId,
          refereeId,
          kind: ReferralRewardKind.MembershipToken,
          status: ReferralRewardStatus.Pending,
          tokenAmount,
          points: tierPoints,
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
          firstPaidAt: lockedIsFirstPayment ? now : undefined,
        },
      });

      let refereeBonusReward = null;
      if (lockedIsFirstPayment && monthlyBuzzAmount > 0) {
        const bonus = Math.floor(monthlyBuzzAmount * constants.referrals.refereeBonusBuzzPct);
        if (bonus > 0) {
          // Created Pending with settledAt=now so settleRewardRow below picks
          // it up immediately. The RefereeBonus is a one-way platform welcome
          // gift — there's no chargeback path that could claw it back, so
          // there's no reason to make the referee wait the 7-day window.
          refereeBonusReward = await tx.referralReward.create({
            data: {
              userId: refereeId,
              kind: ReferralRewardKind.RefereeBonus,
              status: ReferralRewardStatus.Pending,
              buzzAmount: bonus,
              points: bonus,
              tierGranted: tier,
              sourceEventId: `referee-bonus:${sourceEventId}`,
              settledAt: now,
            },
          });
        }
      }

      return { reward, refereeBonusReward };
    });

    if (refereeBonusReward) {
      // Settle inline so the referee sees their welcome Blue Buzz immediately,
      // not after the 15-min cron tick. settleRewardRow uses a CAS update so
      // a parallel cron run can't double-grant.
      await settleRewardRow(refereeBonusReward).catch((err) =>
        logToAxiom({
          name: 'referee-bonus-settle',
          type: 'error',
          rewardId: refereeBonusReward.id,
          err: String(err),
        }).catch(() => undefined)
      );
    }

    await recordAttribution({
      referralCodeId: ctx.referralCodeId,
      refereeId,
      eventType: 'membership_payment',
      sourceEventId,
      tier,
      amount: monthlyBuzzAmount,
      metadata: { paidMonthCount: ctx.paidMonthCount + 1, tokens: tokenAmount },
      payment,
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
    if ((err as { __overCap?: boolean })?.__overCap) return null;
    throw err;
  }
}

export async function recordBuzzPurchaseKickback(params: {
  refereeId: number;
  buzzAmount: number;
  sourceEventId: string;
  purchasedAt?: Date;
  payment?: AttributionPayment;
}) {
  const { refereeId, buzzAmount, sourceEventId, purchasedAt, payment } = params;
  if (buzzAmount <= 0) return null;

  const ctx = await resolveReferrerForReferee(refereeId);
  if (!ctx) {
    // Buzz purchases by users with no referral binding are common; only log
    // when the buzzAmount is large enough to be worth investigating, so we
    // don't drown the dataset in noise.
    if (buzzAmount >= 1000) {
      logToAxiom({
        name: 'referral-kickback-no-context',
        type: 'info',
        refereeId,
        buzzAmount,
        sourceEventId,
      }).catch(() => undefined);
    }
    return null;
  }
  if (!ctx.firstPaidAt) {
    await recordAttribution({
      referralCodeId: ctx.referralCodeId,
      refereeId,
      eventType: 'buzz_kickback_skipped_no_membership',
      sourceEventId,
      amount: buzzAmount,
      payment,
    });
    return null;
  }

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
        points: kickback,
        sourceEventId,
        earnedAt: now,
        settledAt: settlementDate(now),
      },
    });

    await recordAttribution({
      referralCodeId: ctx.referralCodeId,
      refereeId,
      eventType: 'buzz_kickback',
      sourceEventId,
      amount: buzzAmount,
      metadata: { kickback },
      payment,
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

  const { createNotification } = await import('~/server/services/notification.service');
  const { NotificationCategory } = await import('~/server/common/enums');

  if (reward.kind === ReferralRewardKind.RefereeBonus) {
    await createNotification({
      type: 'referral-welcome-bonus',
      userId: reward.userId,
      category: NotificationCategory.Buzz,
      key: `referral-welcome-bonus:${reward.id}`,
      details: { blueBuzz: reward.buzzAmount },
    }).catch(() => undefined);
  } else {
    emitSignal(reward.userId, SignalMessages.ReferralSettled, {
      rewardId: reward.id,
      type: reward.kind === ReferralRewardKind.MembershipToken ? 'membership' : 'buzz',
      tokens: reward.tokenAmount || undefined,
      blueBuzz: reward.buzzAmount || undefined,
    });
    await createNotification({
      type: 'referral-reward-settled',
      userId: reward.userId,
      category: NotificationCategory.Buzz,
      key: `referral-reward-settled:${reward.id}`,
      details: {
        tokens: reward.tokenAmount,
        blueBuzz: reward.buzzAmount,
        kind: reward.kind,
      },
    }).catch(() => undefined);
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
    select: { id: true, userId: true, kind: true, refereeId: true, status: true, buzzAmount: true },
  });
  if (!affected.length) return { revoked: 0 };

  // Track referees whose paidMonthCount needs to drop. A refunded membership
  // payment must clear its credit on the UserReferral row so the referee can't
  // refund-and-keep-Buzz-kickbacks: BuzzKickback eligibility checks
  // `firstPaidAt`, so leaving that set after a refunded first month would let
  // the referrer keep collecting kickbacks on a free account.
  const refereeDecrements = new Map<number, number>();

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
    if (reward.kind === ReferralRewardKind.MembershipToken && reward.refereeId) {
      refereeDecrements.set(reward.refereeId, (refereeDecrements.get(reward.refereeId) ?? 0) + 1);
    }
    emitSignal(reward.userId, SignalMessages.ReferralClawback, {
      rewardId: reward.id,
      reason,
    });
  }

  for (const [refereeId, decrement] of refereeDecrements) {
    await dbWrite.$transaction(async (tx) => {
      // Lock the row so two concurrent chargebacks for the same referee don't
      // both read the same paidMonthCount and lose one of the decrements.
      const locked = await tx.$queryRaw<{ id: number; paidMonthCount: number }[]>(Prisma.sql`
        SELECT id, "paidMonthCount"
        FROM "UserReferral"
        WHERE "userId" = ${refereeId}
        FOR UPDATE
      `);
      const ref = locked[0];
      if (!ref) return;
      const next = Math.max(0, ref.paidMonthCount - decrement);
      await tx.userReferral.update({
        where: { id: ref.id },
        data: {
          paidMonthCount: next,
          // If they've now lost every paid month they ever had, clear the
          // firstPaidAt anchor so future buzz purchases stop generating
          // kickbacks for the referrer until they pay for membership again.
          firstPaidAt: next === 0 ? null : undefined,
        },
      });
    });
  }

  return { revoked: affected.length };
}

export async function awardMilestones(userId: number) {
  const lifetime = await computeLifetimeReferralPoints(userId);
  if (lifetime <= 0) return;

  const topAffiliateCosmeticId = await getTopAffiliateCosmeticId();

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
            points: m.bonus,
            sourceEventId: `milestone:${userId}:${m.threshold}`,
            settledAt: settlementDate(),
          },
        });
      });
      emitSignal(userId, SignalMessages.ReferralMilestone, {
        threshold: m.threshold,
        bonusAmount: m.bonus,
      });
      {
        const { createNotification } = await import('~/server/services/notification.service');
        const { NotificationCategory } = await import('~/server/common/enums');
        await createNotification({
          type: 'referral-milestone-hit',
          userId,
          category: NotificationCategory.Buzz,
          key: `referral-milestone-hit:${userId}:${m.threshold}`,
          details: { threshold: m.threshold, bonusAmount: m.bonus },
        }).catch(() => undefined);
      }
      // Top Affiliate badge on the 1M threshold. Uses the most recent available
      // cosmetic as a placeholder until a bespoke one is authored.
      if (m.threshold >= 1_000_000 && topAffiliateCosmeticId) {
        const { grantCosmetics } = await import('~/server/services/cosmetic.service');
        await grantCosmetics({ userId, cosmeticIds: [topAffiliateCosmeticId] }).catch(
          () => undefined
        );
      }
    } catch (err) {
      if (isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

async function getTopAffiliateCosmeticId(): Promise<number | null> {
  // @ai:* Placeholder: grab the most recently created active Cosmetic. Replace
  // with a bespoke "Top Affiliate" cosmetic once Ally designs one. Cache
  // shouldn't matter here since the 1M milestone is extremely rare.
  const cosmetic = await dbRead.cosmetic.findFirst({
    where: { availableStart: { lte: new Date() } },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  });
  return cosmetic?.id ?? null;
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
    const { createNotification } = await import('~/server/services/notification.service');
    const { NotificationCategory } = await import('~/server/common/enums');
    const expiresAtKey = row._min.expiresAt
      ? row._min.expiresAt.toISOString().slice(0, 10)
      : 'soon';
    // Dedupe per-user per-expiry-date so the daily cron doesn't spam. If the
    // key already exists the notification service upserts / dedupes.
    await createNotification({
      type: 'referral-token-expiring',
      userId: row.userId,
      category: NotificationCategory.Buzz,
      key: `referral-token-expiring:${row.userId}:${expiresAtKey}`,
      details: {
        tokens: row._sum.tokenAmount ?? 0,
        expiresAt: row._min.expiresAt,
      },
    }).catch(() => undefined);
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

// Referral Points drive the milestone ladder and Recruiter Score.
// 1 point per Blue Buzz earned (buzz kickbacks + milestone bonuses, once
// they've cleared), plus a tier-weighted lump per paid referral month
// from MembershipToken rows. Each row stores its own `points` snapshot at write
// time so this is a straight sum — re-tuning constants.referrals.pointsPerTierMonth
// later will only affect future rows, not historical ones. Expired tokens still
// count toward lifetime points: expiry only blocks redemption, the user did
// historically earn the points and shouldn't lose milestone progress for it.
export async function computeLifetimeReferralPoints(userId: number) {
  const agg = await dbRead.referralReward.aggregate({
    where: {
      userId,
      kind: {
        in: [
          ReferralRewardKind.BuzzKickback,
          ReferralRewardKind.MilestoneBonus,
          ReferralRewardKind.MembershipToken,
        ],
      },
      status: {
        in: [
          ReferralRewardStatus.Settled,
          ReferralRewardStatus.Redeemed,
          ReferralRewardStatus.Expired,
        ],
      },
    },
    _sum: { points: true },
  });
  return agg._sum.points ?? 0;
}

export async function getReferrerBalance(userId: number) {
  const groups = await dbRead.referralReward.groupBy({
    by: ['kind', 'status'],
    where: {
      userId,
      // Include Expired so lifetimeTokens accumulates rewards the user
      // earned but never spent — they still "earned" them.
      status: {
        in: [
          ReferralRewardStatus.Pending,
          ReferralRewardStatus.Settled,
          ReferralRewardStatus.Redeemed,
          ReferralRewardStatus.Expired,
        ],
      },
    },
    _sum: { tokenAmount: true, buzzAmount: true },
  });

  let settledTokens = 0;
  let pendingTokens = 0;
  let lifetimeTokens = 0;
  let settledBlueBuzzLifetime = 0;
  let pendingBlueBuzz = 0;

  for (const g of groups) {
    const tokens = g._sum.tokenAmount ?? 0;
    const buzz = g._sum.buzzAmount ?? 0;
    if (g.kind === ReferralRewardKind.MembershipToken) {
      if (g.status === ReferralRewardStatus.Settled) settledTokens += tokens;
      if (g.status === ReferralRewardStatus.Pending) pendingTokens += tokens;
      // Lifetime = anything that ever became real (Settled + Redeemed + Expired).
      // Excludes Pending (not yet earned) and Revoked (chargebacks/abuse).
      if (
        g.status === ReferralRewardStatus.Settled ||
        g.status === ReferralRewardStatus.Redeemed ||
        g.status === ReferralRewardStatus.Expired
      ) {
        lifetimeTokens += tokens;
      }
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

  // Earliest expiry of any settled, unredeemed token — that's when the user
  // starts losing unspent tokens if they sit on them. Also sum tokens that
  // expire within the next 30 days so the UI can flag "use them or lose them".
  const now = new Date();
  const expiringSoonCutoff = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const expiringRows = await dbRead.referralReward.findMany({
    where: {
      userId,
      kind: ReferralRewardKind.MembershipToken,
      status: ReferralRewardStatus.Settled,
      expiresAt: { not: null, gt: now },
    },
    orderBy: { expiresAt: 'asc' },
    select: { tokenAmount: true, expiresAt: true },
  });

  const nextTokenExpiresAt = expiringRows[0]?.expiresAt ?? null;
  const expiringSoonTokens = expiringRows
    .filter((r) => r.expiresAt && r.expiresAt < expiringSoonCutoff)
    .reduce((sum, r) => sum + (r.tokenAmount ?? 0), 0);

  // Referral Points — the metric behind both milestone progress and
  // Referral Score. Sum the per-row `points` snapshot so historical rewards
  // stay frozen at the value they had when written.
  const pointsByStatus = await dbRead.referralReward.groupBy({
    by: ['status'],
    where: {
      userId,
      kind: {
        in: [
          ReferralRewardKind.BuzzKickback,
          ReferralRewardKind.MilestoneBonus,
          ReferralRewardKind.MembershipToken,
        ],
      },
      // Include Expired so token expiry doesn't yank the user's lifetime
      // points down — they still earned them.
      status: {
        in: [
          ReferralRewardStatus.Pending,
          ReferralRewardStatus.Settled,
          ReferralRewardStatus.Redeemed,
          ReferralRewardStatus.Expired,
        ],
      },
    },
    _sum: { points: true },
  });
  let lifetimePoints = 0;
  let pendingPoints = 0;
  for (const row of pointsByStatus) {
    const pts = row._sum.points ?? 0;
    if (row.status === ReferralRewardStatus.Pending) pendingPoints += pts;
    else lifetimePoints += pts;
  }

  return {
    settledTokens,
    pendingTokens,
    lifetimeTokens,
    settledBlueBuzzLifetime,
    pendingBlueBuzz,
    lifetimePoints,
    pendingPoints,
    nextTokenExpiresAt,
    expiringSoonTokens,
  };
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

type ReferralQueueEntry = { tier: string; durationDays: number };
type ReferralSubMetadata = {
  source?: string;
  referralQueue?: ReferralQueueEntry[];
  [key: string]: unknown;
};

export function collapseTierQueue(items: ReferralQueueEntry[]): ReferralQueueEntry[] {
  // Sort highest tier first using memberships.tierOrder. Within the same tier,
  // collapse consecutive entries into one so we don't bloat the metadata.
  const ladder = constants.memberships.tierOrder as readonly string[];
  const rank = (t: string) => {
    const i = ladder.indexOf(t);
    return i < 0 ? -1 : i;
  };
  const sorted = [...items]
    .filter((i) => i.durationDays > 0)
    .sort((a, b) => rank(b.tier) - rank(a.tier));
  const collapsed: ReferralQueueEntry[] = [];
  for (const item of sorted) {
    const last = collapsed[collapsed.length - 1];
    if (last && last.tier === item.tier) last.durationDays += item.durationDays;
    else collapsed.push({ ...item });
  }
  return collapsed;
}

async function grantReferralSubscription(
  tx: Prisma.TransactionClient,
  userId: number,
  tier: string,
  durationDays: number
) {
  // Referral grants are "tier-time chunks" queued on a single CustomerSubscription
  // keyed by buzzType='referral'. Each chunk keeps its original tier. Higher tiers
  // always active first; on expiry a cron (advanceReferralSubs) promotes the next
  // chunk. Blocks the "stack cheap Bronze + one Gold = all Gold" exploit Justin
  // flagged — each chunk only ever grants its own tier for its own duration.
  //
  // Lock the row so a concurrent advance-cron run can't read+rewrite the queue
  // around our update and erase a chunk we're appending.
  await tx.$queryRaw(Prisma.sql`
    SELECT id
    FROM "CustomerSubscription"
    WHERE "userId" = ${userId} AND "buzzType" = ${REFERRAL_BUZZ_TYPE}
    FOR UPDATE
  `);
  const existing = await tx.customerSubscription.findUnique({
    where: { userId_buzzType: { userId, buzzType: REFERRAL_BUZZ_TYPE } },
    select: {
      id: true,
      status: true,
      currentPeriodEnd: true,
      metadata: true,
      productId: true,
      product: { select: { metadata: true } },
    },
  });

  const now = new Date();

  // Pool all unspent tier-time: the currently-active chunk's remaining days + the
  // queued chunks + the new redemption. Collapse + sort by tier DESC. First goes
  // active, rest queue.
  const pool: ReferralQueueEntry[] = [];

  if (existing && existing.status === 'active' && existing.currentPeriodEnd > now) {
    const existingTier = (existing.product.metadata as { tier?: string } | null)?.tier;
    if (existingTier) {
      const remainingDays = Math.max(
        0,
        Math.ceil((existing.currentPeriodEnd.getTime() - now.getTime()) / 86_400_000)
      );
      if (remainingDays > 0) pool.push({ tier: existingTier, durationDays: remainingDays });
    }
  }

  const existingMeta = (existing?.metadata as ReferralSubMetadata | null) ?? {};
  if (Array.isArray(existingMeta.referralQueue)) {
    pool.push(...existingMeta.referralQueue);
  }

  // Reject the redemption (refund the cost upstream) if the user is already
  // sitting on more than maxQueuedDays of perks. Without a cap a hot referrer
  // could queue years of tier-time and eventually trip Stripe's 2038 date max.
  const existingPoolDays = pool.reduce((sum, entry) => sum + entry.durationDays, 0);
  if (existingPoolDays + durationDays > constants.referrals.maxQueuedDays) {
    throw new Error(
      `Referral perk queue is full. You already have ${existingPoolDays} days of perks queued; the cap is ${constants.referrals.maxQueuedDays} days. Spend some perks before redeeming more.`
    );
  }

  pool.push({ tier, durationDays });

  const ordered = collapseTierQueue(pool);
  if (ordered.length === 0) throw new Error('Nothing to grant');

  const [active, ...queue] = ordered;
  const product = await findReferralProductForTier(active.tier);
  if (!product || !product.defaultPriceId) {
    await logToAxiom({
      name: 'referral-grant-missing-product',
      type: 'error',
      userId,
      tier: active.tier,
    }).catch(() => undefined);
    throw new Error(
      'Referral tier products are not yet configured. Your tokens have not been spent.'
    );
  }

  const newPeriodEnd = dayjs(now).add(active.durationDays, 'day').toDate();
  const nextMetadata: ReferralSubMetadata = {
    ...existingMeta,
    source: 'referral-redemption',
    referralQueue: queue,
  };

  if (!existing) {
    await tx.customerSubscription.create({
      data: {
        id: `referral:${userId}:${Date.now()}`,
        userId,
        buzzType: REFERRAL_BUZZ_TYPE,
        status: 'active',
        productId: product.id,
        priceId: product.defaultPriceId,
        cancelAtPeriodEnd: true,
        currentPeriodStart: now,
        currentPeriodEnd: newPeriodEnd,
        createdAt: now,
        updatedAt: now,
        metadata: nextMetadata as Prisma.InputJsonValue,
      },
    });
    return { created: true, activeTier: active.tier, queuedCount: queue.length };
  }

  await tx.customerSubscription.update({
    where: { id: existing.id },
    data: {
      status: 'active',
      productId: product.id,
      priceId: product.defaultPriceId,
      currentPeriodStart: now,
      currentPeriodEnd: newPeriodEnd,
      cancelAtPeriodEnd: true,
      metadata: nextMetadata as Prisma.InputJsonValue,
    },
  });
  return { updated: true, activeTier: active.tier, queuedCount: queue.length };
}

// Cron-facing: advance any referral sub whose current period has ended by
// promoting the next-highest-tier chunk from its queue. If the queue is empty,
// cancel the sub.
export async function advanceReferralSubscriptions(now: Date = new Date()) {
  const due = await dbWrite.customerSubscription.findMany({
    where: {
      buzzType: REFERRAL_BUZZ_TYPE,
      status: 'active',
      currentPeriodEnd: { lte: now },
    },
    select: { id: true, userId: true, metadata: true },
    take: 500,
  });
  if (!due.length) return { advanced: 0, canceled: 0 };

  let advanced = 0;
  let canceled = 0;

  for (const sub of due) {
    // Lock the row inside a per-sub tx and re-read its metadata. A user
    // calling redeemTokens (which calls grantReferralSubscription) right as
    // the cron picks up the row would otherwise have their newly-appended
    // queue entries silently overwritten by our update.
    const result = await dbWrite.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        { id: string; metadata: Prisma.JsonValue; currentPeriodEnd: Date }[]
      >(Prisma.sql`
        SELECT id, metadata, "currentPeriodEnd"
        FROM "CustomerSubscription"
        WHERE id = ${sub.id}
        FOR UPDATE
      `);
      const lockedSub = locked[0];
      if (!lockedSub) return 'noop' as const;
      // Re-check that the period is still expired — another writer (e.g. a
      // redemption that bumped the period out) may have made this no longer due.
      if (lockedSub.currentPeriodEnd > now) return 'noop' as const;

      const meta = (lockedSub.metadata as ReferralSubMetadata | null) ?? {};
      const queue = Array.isArray(meta.referralQueue) ? meta.referralQueue : [];
      const ordered = collapseTierQueue(queue);

      if (ordered.length === 0) {
        await tx.customerSubscription.update({
          where: { id: sub.id },
          data: { status: 'canceled', canceledAt: now, endedAt: now },
        });
        return 'canceled' as const;
      }

      const [next, ...rest] = ordered;
      const product = await findReferralProductForTier(next.tier);
      if (!product || !product.defaultPriceId) {
        await logToAxiom({
          name: 'referral-advance-missing-product',
          type: 'error',
          subId: sub.id,
          tier: next.tier,
        }).catch(() => undefined);
        return 'noop' as const;
      }

      const newEnd = dayjs(now).add(next.durationDays, 'day').toDate();
      await tx.customerSubscription.update({
        where: { id: sub.id },
        data: {
          productId: product.id,
          priceId: product.defaultPriceId,
          currentPeriodStart: now,
          currentPeriodEnd: newEnd,
          metadata: {
            ...meta,
            source: 'referral-redemption',
            referralQueue: rest,
          } as Prisma.InputJsonValue,
        },
      });
      return 'advanced' as const;
    });

    if (result === 'advanced') advanced++;
    else if (result === 'canceled') canceled++;
  }

  return { advanced, canceled };
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
        rewardType: 'MembershipPerks',
        metadata: {
          tier: offer.tier,
          durationDays: offer.durationDays,
          subscriptionId: `referral:${userId}:${offer.tier}`,
        } as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true, tokensSpent: true, rewardType: true, metadata: true },
    });
  });

  emitSignal(userId, SignalMessages.ReferralTierGranted, {
    redemptionId: redemption.id,
    tier: offer.tier,
    durationDays: offer.durationDays,
  });

  return redemption;
}
