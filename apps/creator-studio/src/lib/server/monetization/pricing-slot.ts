import {
  MONETIZATION_MIN_CREATOR_SCORE,
  exceedsAllowance,
  monthlyPricingAllowance,
  pricingAllowanceMessage,
  pricingFloorMessage,
  pricingMonthStart,
} from '@civitai/buzz';
import { dbRead, dbWrite } from '$lib/server/db';
import { getModelsScore } from '$lib/server/creator-score';
import { cappedTier, type Membership } from '$lib/server/membership';

// This spoke's direct-SQL writes never reach the main app's service layer, so both pricing rules are
// enforced here too — a rule not applied here is a rule this spoke can bypass. The rules themselves
// live in @civitai/buzz.

export type PricingGateResult = { ok: true } | { ok: false; status: 400 | 403; error: string };

// Which of `versionIds` carry NO price yet — no licensing fee and no permanent gate. These are the ones a
// write would move from unpriced to priced, and so the only ones that spend eligibility or allowance.
//
// The ONE definition of that question for this app: the fee paths and both gate actions all call it.
// The fee path used to ask `currentFee <= 0` instead, which charged a creator a second time for a
// version they already sold through a gate, and refused it outright at a full month.
//
// Ownership is re-enforced here: the ids come from an owner-scoped read, but this decides a money rule.
export async function unpricedVersionIds(userId: number, versionIds: number[]): Promise<number[]> {
  if (versionIds.length === 0) return [];
  const rows = await dbRead
    .selectFrom('ModelVersion as mv')
    .innerJoin('Model as m', 'm.id', 'mv.modelId')
    .leftJoin('PaidAccess as pa', (join) =>
      join
        .onRef('pa.entityId', '=', 'mv.id')
        .on('pa.entityType', '=', 'ModelVersion')
        .on('pa.timeframeDays', 'is', null)
    )
    .select(['mv.id as id', 'mv.licensingFee as fee', 'pa.entityId as gated'])
    .where('mv.id', 'in', versionIds)
    .where('m.userId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .execute();
  return rows.filter((r) => Number(r.fee ?? 0) <= 0 && r.gated == null).map((r) => r.id);
}

/** Slots spent this calendar month. Index-only on (ownerId, createdAt). */
export async function countPricingSlotsThisMonth(ownerId: number): Promise<number> {
  const row = await dbRead
    .selectFrom('PricingSlot')
    .select(({ fn }) => fn.countAll<string>().as('count'))
    .where('ownerId', '=', ownerId)
    .where('createdAt', '>=', pricingMonthStart())
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

/**
 * Record that versions have been priced. Idempotent by primary key — a version that has been priced
 * before costs nothing, which is the whole of "one slot per entity, spent once, never returned".
 * Call it after the write it accompanies succeeds.
 */
export async function recordPricingSlots(
  ownerId: number,
  versionIds: number[],
  db: typeof dbWrite = dbWrite
): Promise<void> {
  if (versionIds.length === 0) return;
  await db
    .insertInto('PricingSlot')
    .values(
      versionIds.map((entityId) => ({ entityType: 'ModelVersion' as const, entityId, ownerId }))
    )
    .onConflict((oc) => oc.columns(['entityType', 'entityId']).doNothing())
    .execute();
}

/**
 * Refuse prices the creator may not set. `newlyPricedCount` is how many versions this write moves from
 * unpriced to priced — editing or clearing an existing price is exempt from both rules and passes zero.
 */
export async function assertPricingAllowed(
  userId: number,
  membership: Membership,
  newlyPricedCount: number
): Promise<PricingGateResult> {
  if (newlyPricedCount <= 0) return { ok: true };

  // The REAL score, not resolveModelsScore: the moderator score simulator moves what this page shows,
  // never what it enforces. Simulating past a money gate would make the simulator a bypass.
  const score = await getModelsScore(userId);
  if (score < MONETIZATION_MIN_CREATOR_SCORE)
    return { ok: false, status: 403, error: pricingFloorMessage() };

  const limit = monthlyPricingAllowance(cappedTier(membership));
  if (!Number.isFinite(limit)) return { ok: true };

  const used = await countPricingSlotsThisMonth(userId);
  // Counted for the whole batch: a bulk write is all-or-nothing, so it is refused rather than
  // half-applied. At count=1 this is the same test the single-version paths make.
  if (exceedsAllowance(used, limit, newlyPricedCount))
    return { ok: false, status: 403, error: pricingAllowanceMessage(used, limit) };

  return { ok: true };
}
