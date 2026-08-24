import type { Prisma, PrismaClient } from '@prisma/client';
import {
  MONETIZATION_MIN_CREATOR_SCORE,
  exceedsAllowance,
  monthlyPricingAllowance,
  pricingAllowanceMessage,
  pricingFloorMessage,
  pricingMonthStart,
} from '@civitai/buzz';
import { dbRead, dbWrite } from '~/server/db/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';

// The queries and the ordering behind the two pricing rules; the rules themselves are in
// @civitai/buzz, shared with the creator-studio spoke, which enforces them against the same database
// through its own SQL.

/** The entity kinds that can carry a price. Mirrors PaidAccessEntityType. */
export type PricingSlotEntityType = 'ModelVersion' | 'ComicChapter';

type UserMetaScores = { scores?: { models?: number } };

/** Absent or malformed meta reads as 0 — this decides who may start charging, so it fails closed. */
export function creatorScoreFromMeta(meta: unknown): number {
  const score = (meta as UserMetaScores | null | undefined)?.scores?.models;
  return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

export async function getCreatorScore(userId: number): Promise<number> {
  const user = await dbRead.user.findUnique({ where: { id: userId }, select: { meta: true } });
  return creatorScoreFromMeta(user?.meta);
}

/** Slots spent this calendar month. Index-only on (ownerId, createdAt) — no join. */
export async function countPricingSlotsThisMonth(ownerId: number): Promise<number> {
  return dbRead.pricingSlot.count({
    where: { ownerId, createdAt: { gte: pricingMonthStart() } },
  });
}

/**
 * Idempotent by primary key — a slot is spent once and never returned. Call it AFTER the write it
 * accompanies succeeds, or a failed write costs the creator a slot.
 */
export async function recordPricingSlot(
  {
    entityType,
    entityId,
    ownerId,
  }: { entityType: PricingSlotEntityType; entityId: number; ownerId: number },
  tx?: Prisma.TransactionClient | PrismaClient
): Promise<void> {
  const db = tx ?? dbWrite;
  await db.pricingSlot.createMany({
    data: [{ entityType, entityId, ownerId }],
    skipDuplicates: true,
  });
}

export type PricingWriteCheck = {
  userId: number;
  /**
   * Whether the entity carries a price BEFORE this write. Editing an existing price is exempt from
   * both rules, so this is the single thing that decides whether they apply at all. Callers get it
   * from `isAlreadyPriced`.
   */
  wasPriced: boolean;
  /** Whether it will carry one after. */
  willBePriced: boolean;
  /**
   * The owner's tier, or a thunk resolving it. Pass the thunk from a hot write path: `getCapTier` is
   * three uncached queries against the primary, and the tier is only read once a write turns out to
   * price something new — a small minority of saves.
   */
  tier: TierInput;
  /** Already-loaded `User.meta`, when the caller has it — saves a query. */
  userMeta?: unknown;
};

export type TierInput = string | null | undefined | (() => Promise<string | null>);

/**
 * Refuse a new price the creator may not set. Returns whether the write, if it succeeds, must spend a
 * slot — the caller records it with recordPricingSlot once the entity is written.
 */
export async function assertPricingAllowed({
  userId,
  wasPriced,
  willBePriced,
  tier,
  userMeta,
}: PricingWriteCheck): Promise<{ spendsSlot: boolean }> {
  if (!willBePriced || wasPriced) return { spendsSlot: false };

  const score =
    userMeta !== undefined ? creatorScoreFromMeta(userMeta) : await getCreatorScore(userId);
  if (score < MONETIZATION_MIN_CREATOR_SCORE)
    throw throwBadRequestError(pricingFloorMessage(score));

  const limit = monthlyPricingAllowance(typeof tier === 'function' ? await tier() : tier);
  if (Number.isFinite(limit)) {
    const used = await countPricingSlotsThisMonth(userId);
    if (exceedsAllowance(used, limit))
      throw throwBadRequestError(pricingAllowanceMessage(used, limit));
  }

  return { spendsSlot: true };
}
