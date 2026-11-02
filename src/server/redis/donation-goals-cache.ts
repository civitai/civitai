import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { loadKyselyDb } from '~/server/db/kyselyDb.lazy';
import { FLIPT_FEATURE_FLAGS, isFlipt } from '~/server/flipt/client';
import { dbReadFallbackCounter } from '~/server/prom/client';
import {
  readActiveDonationGoalsViaKysely,
  readActiveDonationGoalsViaPrisma,
  readExistingModelVersionIdsViaKysely,
  readExistingModelVersionIdsViaPrisma,
} from '~/server/services/hot-reads-6.reads';

// A single public (non-owner, non-moderator) donation goal, shaped byte-identically to
// `modelVersionDonationGoal`' output element: the DonationGoal row fields it selects plus
// the summed `total`. Privileged (owner/mod) responses can include unpublished/draft goals
// and MUST NOT enter the shared public cache — see `modelVersionDonationGoal` for the gate.
export type DonationGoalWithTotal = {
  id: number;
  goalAmount: number;
  title: string;
  active: boolean;
  userId: number;
  createdAt: Date;
  description: string | null;
  total: number;
};
export type ModelVersionPublicDonationGoalCacheItem = {
  modelVersionId: number;
  // A version has at most one donation goal. `null` = exists but no public goal (distinct from a
  // missing entry, which means the version itself doesn't exist → 404).
  goal: DonationGoalWithTotal | null;
};

/**
 * lookupFn for `modelVersionPublicDonationGoalsCache` (defined in `caches.ts`). Extracted into
 * this light module (imports only db/prom/@prisma, NOT the caches.ts env/clickhouse/orchestrator
 * graph) so the SECURITY-relevant `active: true` public filter — the single guard keeping
 * inactive/draft goals out of the shared public key — can be tested against the REAL function
 * the cache uses, with no hand-copied "mirror" that could silently diverge.
 *
 * Holds ONLY the version's active donation goal + summed total (refreshed when a donation lands). The
 * display-time public filters — the early-access window (from PaidAccess) and the creator opt-out
 * (CP membership) — are time/membership-sensitive and applied at READ time in `getDonationGoals`,
 * NOT baked in here where a short TTL would serve a stale verdict. Existence uses the same
 * replica→primary fallback as the uncached read (the primary alone under fromWrite); seeds an entry for every EXISTING version (goal
 * null if none) so the caller can tell "exists, no goal" from "does not exist" (→ 404).
 */
export const publicDonationGoalsLookupFn = async (
  ids: number[],
  fromWrite?: boolean
): Promise<Record<number, ModelVersionPublicDonationGoalCacheItem>> => {
  // The replica reads (never the primary's) go through Kysely when this is on.
  const replica =
    !fromWrite && (await isFlipt(FLIPT_FEATURE_FLAGS.KYSELY_HOT_READS_6))
      ? (await loadKyselyDb()).kyselyRead
      : undefined;

  // fromWrite (refresh() right after a write) checks existence on the primary too: a version created
  // moments ago may not be on the replica, and an empty result here makes refresh() delete the entry.
  let versions = replica
    ? await readExistingModelVersionIdsViaKysely(replica, ids)
    : await readExistingModelVersionIdsViaPrisma(fromWrite ? dbWrite : dbRead, ids);
  if (!fromWrite && versions.length < ids.length) {
    const found = new Set(versions.map((v) => v.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      dbReadFallbackCounter.inc({
        entity: 'modelVersion',
        caller: 'modelVersionPublicDonationGoalsCache',
      });
      const fromPrimary = await readExistingModelVersionIdsViaPrisma(dbWrite, missing);
      versions = versions.concat(fromPrimary);
    }
  }
  if (versions.length === 0) return {};

  const db = fromWrite ? dbWrite : dbRead;

  // PUBLIC filter: only active goals (draft/inactive goals are owner/mod-only). Both readers'
  // `active = true` (hot-reads-6.reads.ts, hot-reads-6.db.ts) is the one invariant that keeps
  // drafts out of the shared public key — do NOT drop it. (The Prisma one is asserted by
  // `model-version-public-donation-goals-cache.test.ts`, the Kysely one by the hot-reads-6 parity
  // suite's inactive-goal fixture.)
  const versionIds = versions.map((v) => v.id);
  const goals = replica
    ? await readActiveDonationGoalsViaKysely(replica, versionIds)
    : await readActiveDonationGoalsViaPrisma(db, versionIds);

  const totalByGoalId = new Map<number, number>();
  const goalIds = goals.map((g) => g.id);
  if (goalIds.length > 0) {
    const totals = await db.$queryRaw<{ donationGoalId: number; total: number }[]>`
      SELECT
        "donationGoalId",
        SUM("amount")::int as total
      FROM "Donation"
      WHERE "donationGoalId" IN (${Prisma.join(goalIds)})
      GROUP BY "donationGoalId"
    `;
    for (const t of totals) totalByGoalId.set(t.donationGoalId, t.total);
  }

  const result: Record<number, ModelVersionPublicDonationGoalCacheItem> = {};
  for (const v of versions) result[v.id] = { modelVersionId: v.id, goal: null };

  for (const goal of goals) {
    const { entityId, ...rest } = goal;
    if (entityId == null) continue;
    if (result[entityId].goal != null) continue; // a version has at most one goal — first match wins
    result[entityId].goal = { ...rest, total: totalByGoalId.get(goal.id) ?? 0 };
  }

  return result;
};
