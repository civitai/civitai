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
  const referral = await dbRead.userReferral.findUnique({
    where: { userId: refereeId },
    select: {
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
  payment?: AttributionPayment;
}) {
  const { refereeId, tier, monthlyBuzzAmount, sourceEventId, paidAt, payment } = params;
  const ctx = await resolveReferrerForReferee(refereeId);
  if (!ctx) return null;
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
  if (!ctx) return null;
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
    const meta = (sub.metadata as ReferralSubMetadata | null) ?? {};
    const queue = Array.isArray(meta.referralQueue) ? meta.referralQueue : [];
    const ordered = collapseTierQueue(queue);

    if (ordered.length === 0) {
      await dbWrite.customerSubscription.update({
        where: { id: sub.id },
        data: { status: 'canceled', canceledAt: now, endedAt: now },
      });
      canceled++;
      continue;
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
      continue;
    }

    const newEnd = dayjs(now).add(next.durationDays, 'day').toDate();
    await dbWrite.customerSubscription.update({
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
    advanced++;
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
