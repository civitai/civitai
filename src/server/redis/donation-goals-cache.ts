import { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { dbReadFallbackCounter } from '~/server/prom/client';

// A single public (non-owner, non-moderator) donation goal, shaped byte-identically to
// `modelVersionDonationGoals`' output element: the DonationGoal row fields it selects plus
// the summed `total`. Privileged (owner/mod) responses can include unpublished/draft goals
// and MUST NOT enter the shared public cache — see `modelVersionDonationGoals` for the gate.
export type ModelVersionPublicDonationGoal = {
  id: number;
  goalAmount: number;
  title: string;
  active: boolean;
  isEarlyAccess: boolean;
  userId: number;
  createdAt: Date;
  description: string | null;
  total: number;
};
export type ModelVersionPublicDonationGoalsCacheItem = {
  modelVersionId: number;
  goals: ModelVersionPublicDonationGoal[];
};

/**
 * lookupFn for `modelVersionPublicDonationGoalsCache` (defined in `caches.ts`). Extracted into
 * this light module (imports only db/prom/@prisma, NOT the caches.ts env/clickhouse/orchestrator
 * graph) so the SECURITY-relevant `active: true` public filter — the single guard keeping
 * inactive/draft goals out of the shared public key — can be tested against the REAL function
 * the cache uses, with no hand-copied "mirror" that could silently diverge.
 *
 * Computes the PUBLIC variant for a set of model version ids: existence (with the same
 * replica→primary fallback as the uncached read), the `active: true` goal filter, the
 * per-version early-access filter, and the summed donation totals. Seeds an entry for every
 * EXISTING version (even with zero goals) so the caller can tell "exists, no goals" (→ []) from
 * "does not exist" (→ 404); missing versions get no entry.
 */
export const publicDonationGoalsLookupFn = async (
  ids: number[],
  fromWrite?: boolean
): Promise<Record<number, ModelVersionPublicDonationGoalsCacheItem>> => {
  const versionSelect = { id: true, earlyAccessEndsAt: true } as const;

  let versions = await dbRead.modelVersion.findMany({
    where: { id: { in: ids } },
    select: versionSelect,
  });
  if (!fromWrite && versions.length < ids.length) {
    const found = new Set(versions.map((v) => v.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      dbReadFallbackCounter.inc({
        entity: 'modelVersion',
        caller: 'modelVersionPublicDonationGoalsCache',
      });
      const fromPrimary = await dbWrite.modelVersion.findMany({
        where: { id: { in: missing } },
        select: versionSelect,
      });
      versions = versions.concat(fromPrimary);
    }
  }
  if (versions.length === 0) return {};

  const earlyAccessById = new Map(versions.map((v) => [v.id, v.earlyAccessEndsAt]));
  const db = fromWrite ? dbWrite : dbRead;

  // PUBLIC filter: only active goals (draft/inactive goals are owner/mod-only). This
  // `active: true` is the one invariant that keeps drafts out of the shared public key — do
  // NOT drop it. (`model-version.donation-goals-lookup.test.ts` asserts it.)
  const goals = await db.donationGoal.findMany({
    where: { modelVersionId: { in: versions.map((v) => v.id) }, active: true },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      isEarlyAccess: true,
      userId: true,
      createdAt: true,
      description: true,
      modelVersionId: true,
    },
  });

  // Creator opt-out: an owner can hide the public donation-goal display for ALL their
  // goals via the `hideDonationGoals` user setting. Non-owner/non-mod viewers go through
  // this cache, so drop those goals here. Owners/mods bypass the cache entirely (see
  // `modelVersionDonationGoals`) and still see their goals.
  const ownerIds = [...new Set(goals.map((g) => g.userId))];
  const hiddenOwnerIds = new Set<number>();
  if (ownerIds.length > 0) {
    const owners = await db.user.findMany({
      where: { id: { in: ownerIds } },
      select: { id: true, settings: true },
    });
    for (const owner of owners) {
      const settings = owner.settings as { hideDonationGoals?: boolean } | null;
      if (settings?.hideDonationGoals) hiddenOwnerIds.add(owner.id);
    }
  }

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

  const result: Record<number, ModelVersionPublicDonationGoalsCacheItem> = {};
  for (const v of versions) result[v.id] = { modelVersionId: v.id, goals: [] };

  const now = new Date();
  for (const goal of goals) {
    const { modelVersionId, ...rest } = goal;
    if (modelVersionId == null) continue;
    if (hiddenOwnerIds.has(goal.userId)) continue;
    // Public early-access filter: an early-access goal is shown publicly only while the
    // version's early-access window is still open. Once it has ended (missing or past
    // `earlyAccessEndsAt`) the goal is hidden from the public — the goal itself keeps
    // working; owners/mods still see it via the uncached privileged path.
    const earlyAccessEndsAt = earlyAccessById.get(modelVersionId);
    if (goal.isEarlyAccess && (!earlyAccessEndsAt || earlyAccessEndsAt <= now)) continue;
    result[modelVersionId].goals.push({ ...rest, total: totalByGoalId.get(goal.id) ?? 0 });
  }

  return result;
};
