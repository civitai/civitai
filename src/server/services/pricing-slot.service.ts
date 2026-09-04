import type { Prisma, PrismaClient } from '@prisma/client';
import type { ModelVersionTerms } from '@civitai/buzz';
import {
  MONETIZATION_MIN_CREATOR_SCORE,
  capTierLabel,
  clearsLastPrice,
  exceedsAllowance,
  gatePrices,
  isAlreadyPriced,
  monthlyPricingAllowance,
  pricingAllowanceMessage,
  pricingFloorMessage,
  pricingMonthStart,
} from '@civitai/buzz';
import { clickhouse } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import { withTimeoutFallback } from '~/server/utils/timeout-helpers';

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
 * Idempotent by primary key. Call it AFTER the write it accompanies succeeds, or a failed write costs
 * the creator a slot. Returned again by releasePricingSlot when the last price comes off.
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

/**
 * How long the charge lookup may take before the caller falls back to the daily mirror. A try/catch
 * cannot catch a hang and the client sets no request_timeout, so without this its own 30s default
 * would hold a creator's save open. The query measures ~4ms; this is a fault budget, not a target.
 */
const CHARGE_LOOKUP_TIMEOUT_MS = 3000;

/**
 * Whether a licensing fee has been charged for a version since `since`.
 *
 * Read straight from `orchestration.resourceCompensations`, which the orchestrator writes on its own
 * compensation flush — so this is current to within one flush interval rather than to the day, which
 * is what `ModelVersionMetric.earnedAmount` mirrors it at.
 *
 * Bounded on `date`, the table's leading sort key, and NOT on `userId`. That column defaults to 0
 * when the owner is unknown and keeps whatever owner was stamped at charge time, so a model transfer
 * or an unknown owner would make an ownership bound silently miss rows — and a miss here refunds a
 * slot that was genuinely spent. Dropping it costs nothing: a range on `date` already stops later
 * key columns skipping granules (measured: 4ms either way over a 3-day window).
 *
 * Returns null when ClickHouse cannot answer, so the caller falls back rather than reading "no".
 */
async function licensingFeeChargedSince(versionId: number, since: Date): Promise<boolean | null> {
  if (!clickhouse) return null;

  try {
    const rows = await withTimeoutFallback<{ charged: number }[] | null>(
      clickhouse.$query<{ charged: number }>`
        SELECT 1 AS charged
        FROM orchestration.resourceCompensations
        WHERE date >= toDate(${since})
          AND modelVersionId = ${versionId}
          AND source = 'licenseFee'
        LIMIT 1
      `,
      CHARGE_LOOKUP_TIMEOUT_MS,
      null
    );
    if (rows === null) return null;
    return rows.length > 0;
  } catch (error) {
    logToAxiom({ type: 'error', name: 'pricing-slot-charge-lookup', error, versionId }).catch(
      () => undefined
    );
    return null;
  }
}

/**
 * Whether anyone has transacted against a version: bought its gate, or been charged its licensing fee.
 *
 * Answers TRUE whenever it cannot tell. Every caller is deciding whether to hand an allowance slot
 * back, so an unanswerable question has to leave the slot spent.
 *
 * Three signals, in order of how well they answer the question:
 *
 * - `EntityAccess` — the paid-access purchase record itself, and exact.
 * - `orchestration.resourceCompensations` — the licensing-fee charges, scoped to `since` so a
 *   version that earned BEFORE this slot was spent does not hold it. Current to one flush interval.
 * - `ModelVersionMetric.earnedAmount` — the daily mirror of that same table, used only when
 *   ClickHouse cannot answer. All-time rather than scoped, and a day behind.
 *
 * A version that was never published skips both fee checks: no buyer could reach it and no generation
 * could charge for it, which makes it the one answer here with no staleness in it.
 */
export async function versionHasTransacted(
  versionId: number,
  ownerId: number,
  since: Date
): Promise<boolean> {
  const [buyers, version] = await Promise.all([
    // Prefix of the primary key. The owner's own row is not a sale — a grant by anyone else is treated
    // as one, since this cannot tell a comp from a purchase and the safe answer is "leave it spent".
    dbRead.entityAccess.count({
      where: {
        accessToId: versionId,
        accessToType: 'ModelVersion',
        accessorId: { not: ownerId },
      },
    }),
    dbRead.modelVersion.findUnique({
      where: { id: versionId },
      select: { initialPublishedAt: true, publishedAt: true },
    }),
  ]);

  if (buyers > 0) return true;
  if (!version) return true;
  if (!version.initialPublishedAt && !version.publishedAt) return false;

  const charged = await licensingFeeChargedSince(versionId, since);
  if (charged !== null) return charged;

  const metric = await dbRead.modelVersionMetric.findUnique({
    where: { modelVersionId: versionId },
    select: { earnedAmount: true },
  });
  return (metric?.earnedAmount ?? 0) > 0;
}

/**
 * Hand back the slot a version spent, if nothing has transacted against it. Call it AFTER the write
 * that removed the last price succeeds.
 *
 * Deleting the row rather than marking it: the allowance counts rows created this calendar month, so a
 * slot spent and returned in the same month becomes spendable again, and one returned in a later month
 * changes nothing — which is what "recovered" has to mean for a monthly allowance.
 */
type ReleaseArgs = {
  entityType: PricingSlotEntityType;
  entityId: number;
  ownerId: number;
};

/**
 * Never throws. This runs AFTER the write that cleared the price, and throwing does not preserve the
 * slot: the retry finds the version already unpriced, so `releasesSlot` is false and the release never
 * runs again. The creator would get a failed save for a write that landed AND still lose the slot.
 * Swallowing leaves the row in place, which makes re-applying the price free — so price-on/price-off
 * recovers it.
 */
export async function releasePricingSlot(args: ReleaseArgs): Promise<boolean> {
  try {
    return await attemptRelease(args);
  } catch (error) {
    logToAxiom({
      type: 'error',
      name: 'pricing-slot-release',
      error,
      entityId: args.entityId,
      ownerId: args.ownerId,
    }).catch(() => undefined);
    return false;
  }
}

async function attemptRelease({ entityType, entityId, ownerId }: ReleaseArgs): Promise<boolean> {
  if (entityType !== 'ModelVersion') return false;

  // The slot's own createdAt bounds the charge lookup: only what was charged while THIS slot was live
  // holds it. A version that earned before its owner priced it keeps nothing hostage.
  // Primary, not the replica: this runs immediately after the write that cleared the price, and a
  // replica still showing the old row makes the release refuse — silently costing the creator the
  // slot it was called to give back. Same reason for the price re-read below.
  const slot = await dbWrite.pricingSlot.findUnique({
    where: { entityType_entityId: { entityType, entityId } },
    select: { createdAt: true, ownerId: true },
  });
  if (!slot || slot.ownerId !== ownerId) return false;

  // Re-read rather than trusting the caller's pre-write intent: a slot is only returnable while the
  // version carries no price at all, and the write that prompted this removed one of the two kinds.
  // The creator-studio mirror answers the same question the same way, off its own post-write read.
  const [version, gate] = await Promise.all([
    dbWrite.modelVersion.findUnique({ where: { id: entityId }, select: { licensingFee: true } }),
    dbWrite.paidAccess.findUnique({
      where: { entityType_entityId: { entityType, entityId } },
      select: { timeframeDays: true },
    }),
  ]);
  if (!version) return false;
  if (
    isAlreadyPriced({
      licensingFee: version.licensingFee != null ? Number(version.licensingFee) : 0,
      hasPermanentGate: gate != null && gate.timeframeDays == null,
    })
  )
    return false;

  if (await versionHasTransacted(entityId, ownerId, slot.createdAt)) return false;

  // Scoped to the owner as well as the key: the slot belongs to whoever spent it, and a row whose
  // ownerId has moved on is not this creator's to return.
  const { count } = await dbWrite.pricingSlot.deleteMany({
    where: { entityType, entityId, ownerId },
  });
  return count > 0;
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

/** What the caller must do about the ledger once its write succeeds. The two are mutually exclusive. */
export type PricingWriteOutcome = {
  spendsSlot: boolean;
  /** The write takes the last price off — the caller offers the slot back with releasePricingSlot. */
  releasesSlot: boolean;
};

/**
 * Refuse a new price the creator may not set, and report what the write owes the ledger: a slot to
 * record with recordPricingSlot, or one to offer back with releasePricingSlot.
 */
export async function assertPricingAllowed({
  userId,
  wasPriced,
  willBePriced,
  tier,
  userMeta,
}: PricingWriteCheck): Promise<PricingWriteOutcome> {
  if (!willBePriced || wasPriced)
    return { spendsSlot: false, releasesSlot: clearsLastPrice({ wasPriced, willBePriced }) };

  const score =
    userMeta !== undefined ? creatorScoreFromMeta(userMeta) : await getCreatorScore(userId);
  if (score < MONETIZATION_MIN_CREATOR_SCORE)
    throw throwBadRequestError(pricingFloorMessage(score));

  const resolvedTier = typeof tier === 'function' ? await tier() : tier;
  const limit = monthlyPricingAllowance(resolvedTier);
  if (Number.isFinite(limit)) {
    const used = await countPricingSlotsThisMonth(userId);
    if (exceedsAllowance(used, limit))
      throw throwBadRequestError(pricingAllowanceMessage(used, limit, capTierLabel(resolvedTier)));
  }

  return { spendsSlot: true, releasesSlot: false };
}

export type PricingSlotEntry = {
  entityType: PricingSlotEntityType;
  entityId: number;
  createdAt: Date;
  countsThisMonth: boolean;
  modelId: number | null;
  modelName: string | null;
  versionName: string | null;
  /** Buzz per image, as stored. Null when the version carries no fee. */
  licensingFee: number | null;
  /** Download price of a permanent gate. Null when the version's only gate is timed. */
  accessPrice: number | null;
  generationPrice: number | null;
};

/**
 * The creator's spent slots, newest first.
 *
 * Amounts are the version's price NOW, not the price at spend time: `PricingSlot` is
 * `{ entityType, entityId, ownerId, createdAt }` keyed on the entity — one row per version, not per
 * event. A real ledger needs `amount`/`releasedAt` columns that do not exist.
 */
export async function listPricingSlots(
  ownerId: number,
  { limit = 100 }: { limit?: number } = {}
): Promise<PricingSlotEntry[]> {
  const slots = await dbRead.pricingSlot.findMany({
    where: { ownerId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { entityType: true, entityId: true, createdAt: true },
  });
  if (slots.length === 0) return [];

  const versionIds = slots
    .filter((slot) => slot.entityType === 'ModelVersion')
    .map((slot) => slot.entityId);
  const [versions, gates] = await Promise.all([
    versionIds.length
      ? dbRead.modelVersion.findMany({
          where: { id: { in: versionIds } },
          select: {
            id: true,
            name: true,
            licensingFee: true,
            model: { select: { id: true, name: true, deletedAt: true } },
          },
        })
      : [],
    versionIds.length
      ? dbRead.paidAccess.findMany({
          where: { entityType: 'ModelVersion', entityId: { in: versionIds } },
          select: { entityId: true, timeframeDays: true, terms: true },
        })
      : [],
  ]);
  const versionById = new Map(versions.map((v) => [v.id, v]));
  // Only a permanent gate is a price — a timed Early Access window must not read as one.
  const gateById = new Map(
    gates.filter((g) => g.timeframeDays == null).map((g) => [g.entityId, g])
  );

  const monthStart = pricingMonthStart();
  return slots.map((slot) => {
    const version = versionById.get(slot.entityId);
    const prices = gatePrices(gateById.get(slot.entityId)?.terms as ModelVersionTerms | undefined);
    const hasGate = gateById.has(slot.entityId);
    const fee = version?.licensingFee != null ? Number(version.licensingFee) : 0;
    return {
      entityType: slot.entityType as PricingSlotEntityType,
      entityId: slot.entityId,
      createdAt: slot.createdAt,
      countsThisMonth: slot.createdAt >= monthStart,
      // A soft-deleted model still holds its slot, so the row stays — but it has no page to link to.
      modelId: version?.model?.deletedAt ? null : version?.model?.id ?? null,
      modelName: version?.model?.name ?? null,
      versionName: version?.name ?? null,
      licensingFee: fee > 0 ? fee : null,
      accessPrice: hasGate ? prices.download : null,
      generationPrice: hasGate && prices.generation > 0 ? prices.generation : null,
    };
  });
}
