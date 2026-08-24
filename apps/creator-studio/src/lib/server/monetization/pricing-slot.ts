import {
  MONETIZATION_MIN_CREATOR_SCORE,
  exceedsAllowance,
  monthlyPricingAllowance,
  pricingAllowanceMessage,
  pricingFloorMessage,
  pricingMonthStart,
} from '@civitai/buzz';
import { getClickhouse } from '$lib/server/clickhouse';
import { withTimeoutFallback } from '$lib/server/timeout';
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
 * before costs nothing. Call it after the write it accompanies succeeds.
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
 * Of `versionIds`, the ones whose slot may be handed back: currently unpriced, and never transacted
 * against. Call it AFTER the write that removed the price, so "currently unpriced" is the post-write
 * answer — the same reason the main app judges a release after its write.
 *
 * Same three signals, same order, as versionHasTransacted in the main app's pricing-slot.service —
 * change both together. Charges are scoped to each slot's own createdAt, so a version that earned
 * BEFORE it was priced does not hold its slot.
 */
export async function releasableVersionIds(
  userId: number,
  versionIds: number[]
): Promise<number[]> {
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
    .leftJoin('ModelVersionMetric as mvm', 'mvm.modelVersionId', 'mv.id')
    .innerJoin('PricingSlot as ps', (join) =>
      join.onRef('ps.entityId', '=', 'mv.id').on('ps.entityType', '=', 'ModelVersion')
    )
    .select(({ eb, selectFrom }) => [
      'mv.id as id',
      'mv.licensingFee as fee',
      'pa.entityId as gated',
      'mv.initialPublishedAt as initialPublishedAt',
      'mv.publishedAt as publishedAt',
      'mvm.earnedAmount as earned',
      // Bounds the charge lookup: only what was charged while THIS slot was live holds it.
      'ps.createdAt as slotCreatedAt',
      eb
        .exists(
          selectFrom('EntityAccess as ea')
            .select('ea.accessToId')
            .whereRef('ea.accessToId', '=', 'mv.id')
            .where('ea.accessToType', '=', 'ModelVersion')
            .where('ea.accessorId', '!=', userId)
        )
        .as('sold'),
    ])
    .where('mv.id', 'in', versionIds)
    .where('m.userId', '=', userId)
    .where('ps.ownerId', '=', userId)
    .where('m.deletedAt', 'is', null)
    .execute();

  const candidates = rows.filter((r) => Number(r.fee ?? 0) <= 0 && r.gated == null && !r.sold);
  const unpublished = candidates.filter((r) => !r.initialPublishedAt && !r.publishedAt);
  const published = candidates.filter((r) => r.initialPublishedAt || r.publishedAt);
  if (published.length === 0) return unpublished.map((r) => r.id);

  const chargedAt = await lastLicensingFeeByVersion(
    published.map((r) => r.id),
    published.reduce(
      (min, r) => (r.slotCreatedAt < min ? r.slotCreatedAt : min),
      published[0].slotCreatedAt
    )
  );

  return [
    ...unpublished.map((r) => r.id),
    ...published
      .filter((r) => {
        // null = ClickHouse could not answer; fall back to the daily mirror rather than to "no".
        if (chargedAt === null) return Number(r.earned ?? 0) <= 0;
        const last = chargedAt.get(r.id);
        return last === undefined || last < r.slotCreatedAt;
      })
      .map((r) => r.id),
  ];
}

/**
 * How long the charge lookup may take before the caller falls back to the daily mirror. A try/catch
 * cannot catch a hang and the client sets no request_timeout, so without this its own 30s default
 * would hold a creator's save open. The query measures ~4ms; this is a fault budget, not a target.
 */
const CHARGE_LOOKUP_TIMEOUT_MS = 3000;

/**
 * The most recent licensing fee charged for each version, from `since` onwards. One query for the
 * whole batch, bounded on `date` — the table's leading sort key — and NOT on `userId`: that column
 * defaults to 0 for an unknown owner and keeps whatever owner was stamped at charge time, so a model
 * transfer would make an ownership bound silently miss rows and return a slot that was really spent.
 *
 * Returns null when ClickHouse cannot answer, so callers fall back rather than reading "nothing charged".
 */
async function lastLicensingFeeByVersion(
  versionIds: number[],
  since: Date
): Promise<Map<number, Date> | null> {
  if (versionIds.length === 0) return new Map();

  try {
    const rows = await withTimeoutFallback<
      { modelVersionId: number | string; last: string }[] | null
    >(
      getClickhouse().$query<{ modelVersionId: number | string; last: string }>(
        `SELECT modelVersionId, max(date) AS last
       FROM orchestration.resourceCompensations
       WHERE date >= toDate('${since.toISOString().slice(0, 10)}')
         AND modelVersionId IN (${versionIds.map((id) => Number(id)).join(',')})
         AND source = 'licenseFee'
       GROUP BY modelVersionId`
      ),
      CHARGE_LOOKUP_TIMEOUT_MS,
      null
    );
    if (rows === null) return null;
    return new Map(rows.map((r) => [Number(r.modelVersionId), new Date(r.last)]));
  } catch (error) {
    console.error('pricing-slot charge lookup failed', error);
    return null;
  }
}

/**
 * Hand back the slots those versions spent. Deleting the rows rather than marking them: the allowance
 * counts rows created this calendar month, so a slot spent and returned in the same month becomes
 * spendable again, and one returned later changes nothing.
 */
export async function releasePricingSlots(
  ownerId: number,
  versionIds: number[],
  db: typeof dbWrite = dbWrite
): Promise<void> {
  if (versionIds.length === 0) return;
  await db
    .deleteFrom('PricingSlot')
    .where('entityType', '=', 'ModelVersion')
    .where('entityId', 'in', versionIds)
    .where('ownerId', '=', ownerId)
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
