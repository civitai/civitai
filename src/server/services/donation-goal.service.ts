import { Prisma } from '@prisma/client';
import { type PaidAccessEntityType, isTimedGateActive } from '@civitai/buzz';
import { dbRead, dbWrite } from '~/server/db/client';
import { dataForModelsCache, modelVersionPublicDonationGoalsCache } from '~/server/redis/caches';
import type { DonationGoalWithTotal } from '~/server/redis/donation-goals-cache';
import { getValidCreatorMembershipMap } from '~/server/services/creator-membership.service';
import type { GetByIdInput } from '~/server/schema/base.schema';
import { TransactionType, type BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { DonateToGoalInput } from '~/server/schema/donation-goal.schema';
import {
  createMultiAccountBuzzTransaction,
  refundMultiAccountTransaction,
} from '~/server/services/buzz.service';
import {
  bustPaidAccessCache,
  endPaidAccessNow,
  getPaidAccess,
} from '~/server/services/paid-access.service';
import { bustMvCache } from '~/server/services/model-version.service';
import { queueModelEarlyAccessReindex } from '~/server/services/model.service';
import { logToAxiom } from '~/server/logging/client';

// Batch read-side accessor for the public donation goal per entity — mirrors getPaidAccess. The
// cache holds only the raw active goal + total; the DISPLAY filters are applied fresh here:
//  - early-access window: a goal shows only while its entity has a live TIMED gate (from PaidAccess).
//  - creator opt-out: hidden while the owner holds a valid CP membership.
// An existing entity with no visible goal → null; a NON-existent entity is omitted (so the endpoint
// can 404). Only ModelVersion has goals today; other entity types return {}.
export async function getDonationGoals(
  entityType: PaidAccessEntityType,
  ids: number[]
): Promise<Partial<Record<number, DonationGoalWithTotal | null>>> {
  if (entityType !== 'ModelVersion' || !ids.length) return {};
  const cached = await modelVersionPublicDonationGoalsCache.fetch(ids);
  const paidAccess = await getPaidAccess('ModelVersion', ids);
  const ownerIds = [
    ...new Set(ids.map((id) => cached[id]?.goal?.userId).filter((x): x is number => x != null)),
  ];
  const hiddenOwnerIds = await getHiddenGoalOwnerIds(ownerIds);
  const now = new Date();

  const result: Record<number, DonationGoalWithTotal | null> = {};
  for (const id of ids) {
    const entry = cached[id];
    if (!entry) continue; // entity doesn't exist → omit (maps to a 404 upstream)
    const goal = entry.goal;
    // Show only while a live TIMED window is open (permanent/ended/absent gates expose nothing).
    const row = paidAccess[id];
    result[id] =
      goal && row && isTimedGateActive(row, now) && !hiddenOwnerIds.has(goal.userId) ? goal : null;
  }
  return result;
}

// Owner/moderator read: the raw goal per entity WITHOUT the public display filters (early-access
// window + creator opt-out) and INCLUDING inactive/draft goals — the privileged variant the edit form
// and the owner branch of `modelVersionDonationGoal` need (a draft/permanent/opted-out/completed
// version still has its goal). NOT cached: the public cache holds only `active: true` goals, so it
// can't serve this. Callers MUST gate on ownership/moderator — never hand this to an anonymous viewer.
//
// Missing-key contract differs from `getDonationGoals` on purpose: this seeds `null` for EVERY id
// (goal-or-null), whereas getDonationGoals OMITS non-existent entities so its 404 path can distinguish
// "no goal" from "no entity". Owner callers resolve entity existence separately, so absence isn't
// meaningful here — seeding null keeps the return total for the caller's known id set.
export async function getOwnerDonationGoals(
  entityType: PaidAccessEntityType,
  ids: number[]
): Promise<Record<number, DonationGoalWithTotal | null>> {
  if (entityType !== 'ModelVersion' || !ids.length) return {};
  const goals = await dbRead.donationGoal.findMany({
    where: { entityType, entityId: { in: ids } },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      userId: true,
      createdAt: true,
      description: true,
      entityId: true,
    },
  });
  const totalByGoalId = await sumDonationsByGoal(goals.map((g) => g.id));
  const result: Record<number, DonationGoalWithTotal | null> = {};
  for (const id of ids) result[id] = null;
  for (const goal of goals) {
    const { entityId, ...rest } = goal;
    if (entityId == null || result[entityId] != null) continue; // one goal per entity — first wins
    result[entityId] = { ...rest, total: totalByGoalId.get(goal.id) ?? 0 };
  }
  return result;
}

// The donated total per goal, summed from Donation. The single spelling of the
// `SUM("amount") … GROUP BY "donationGoalId"` that was hand-copied across every goal read path.
async function sumDonationsByGoal(
  goalIds: number[],
  db: Prisma.TransactionClient = dbRead
): Promise<Map<number, number>> {
  const totals = new Map<number, number>();
  if (!goalIds.length) return totals;
  const rows = await db.$queryRaw<{ donationGoalId: number; total: number }[]>`
    SELECT "donationGoalId", SUM("amount")::int as total
    FROM "Donation"
    WHERE "donationGoalId" IN (${Prisma.join(goalIds)})
    GROUP BY "donationGoalId"
  `;
  for (const r of rows) totals.set(r.donationGoalId, r.total);
  return totals;
}

// Owners who hide their donation goals (a Creator Program benefit) — effective ONLY while the owner
// holds a valid CP membership, so a lapsed/never-member owner's goals become visible again with no
// stored flip.
async function getHiddenGoalOwnerIds(ownerIds: number[]): Promise<Set<number>> {
  const hidden = new Set<number>();
  if (!ownerIds.length) return hidden;
  const owners = await dbRead.user.findMany({
    where: { id: { in: ownerIds } },
    select: { id: true, settings: true },
  });
  const optedOut = owners
    .filter((o) => (o.settings as { hideDonationGoals?: boolean } | null)?.hideDonationGoals)
    .map((o) => o.id);
  if (!optedOut.length) return hidden;
  const membership = await getValidCreatorMembershipMap(optedOut);
  for (const id of optedOut) if (membership.get(id)) hidden.add(id);
  return hidden;
}

// Internal to donateToGoal (the only caller). Loads the goal by numeric id + its donated total.
const donationGoalById = async ({ id, userId }: GetByIdInput & { userId?: number }) => {
  const donationGoal = await dbWrite.donationGoal.findUniqueOrThrow({
    where: {
      id,
    },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      userId: true,
      createdAt: true,
      entityType: true,
      entityId: true,
    },
  });

  // An inactive goal is visible only to its owner; anyone else gets "not found".
  if (!donationGoal.active && donationGoal.userId !== userId) {
    throw new Error('Goal not found');
  }

  const total = (await sumDonationsByGoal([id], dbWrite)).get(id) ?? 0;
  return { ...donationGoal, total };
};

// Entity-keyed load of a goal + its donated total. This is the identity the goal is addressed by
// going forward: phase 2 drops the numeric `id` and makes (entityType, entityId) the primary key.
// (The total is still summed via the Donation.donationGoalId FK — that column is a phase-2 concern.)
const donationGoalByEntity = async ({
  entityType,
  entityId,
}: {
  entityType: PaidAccessEntityType;
  entityId: number;
}) => {
  const donationGoal = await dbWrite.donationGoal.findFirst({
    where: { entityType, entityId },
    select: {
      id: true,
      goalAmount: true,
      title: true,
      active: true,
      userId: true,
      createdAt: true,
      entityType: true,
      entityId: true,
    },
  });
  if (!donationGoal) return null;

  const total = (await sumDonationsByGoal([donationGoal.id], dbWrite)).get(donationGoal.id) ?? 0;
  return { ...donationGoal, total };
};

// Creates a donation goal for an entity. This is purely a DonationGoal concern — it knows nothing
// about PaidAccess/early-access; the gate is created separately by its own writer. Create-once:
// later edits don't retroactively replace an existing goal (an entity has at most one).
export async function ensureDonationGoal(
  {
    entityType,
    entityId,
    amount,
    userId,
    title = 'Donation Goal',
  }: {
    entityType: PaidAccessEntityType;
    entityId: number;
    amount: number;
    userId: number;
    title?: string;
  }) {
  // Create-once is enforced by the partial unique index on (entityType, entityId), not by a prior
  // read: a read-then-create left a window where concurrent early-access writes all saw no goal and
  // each inserted one, splitting the entity's donations across rows that donationGoalByEntity then
  // summed one of at random.
  const inserted = await dbWrite.$executeRaw`
    INSERT INTO "DonationGoal" ("goalAmount", "title", "active", "entityType", "entityId", "modelVersionId", "userId")
    VALUES (
      ${amount},
      ${title},
      true,
      ${entityType}::"PaidAccessEntityType",
      ${entityId},
      -- Dual-written until phase 2 drops the FK column (ModelVersion is its only target).
      ${entityType === 'ModelVersion' ? entityId : null},
      ${userId}
    )
    ON CONFLICT ("entityType", "entityId")
      WHERE "entityType" IS NOT NULL AND "entityId" IS NOT NULL
    DO NOTHING
  `;
  if (inserted === 0) return;
  // Bust like every PaidAccess writer — the cache seeds a `goal: null` entry for an existing version,
  // so without this the public/owner reads serve "no goal" until the TTL backstop lapses.
  await bustPublicDonationGoalsCache(entityType, entityId);
}

export const donateToGoal = async ({
  donationGoalId,
  amount,
  userId,
  buzzType,
}: DonateToGoalInput & {
  userId: number;
  buzzType: BuzzSpendType;
}) => {
  const goal = await donationGoalById({ id: donationGoalId, userId });

  if (buzzType === 'blue') {
    throw new Error('You cannot use Blue Buzz to make donations.');
  }

  if (!goal) {
    throw new Error('Goal not found');
  }

  if (!goal.active) {
    throw new Error('Goal is not active');
  }

  if (goal.userId === userId) {
    throw new Error('User cannot donate to their own goal');
  }

  let performedTransaction = false;
  const externalTransactionIdPrefix = `donation-${donationGoalId}-${Date.now()}`;

  try {
    const transaction = await createMultiAccountBuzzTransaction({
      amount,
      fromAccountId: userId,
      fromAccountTypes: [buzzType],
      toAccountId: goal.userId,
      externalTransactionIdPrefix,
      description: `Donation to ${goal.title}`,
      type: TransactionType.Donation,
    });

    if (!transaction.transactionIds || transaction.transactionIds.length === 0) {
      throw new Error('There was an error creating the transaction.');
    }

    performedTransaction = true;

    await dbWrite.donation.create({
      data: {
        amount,
        buzzTransactionId: externalTransactionIdPrefix, // Store primary transaction ID
        donationGoalId,
        userId,
      },
    });

    // The donation is COMMITTED. Closing the goal + ending the gate is a best-effort side effect that
    // must NOT reach the refund path below — a throw there would reverse a real, committed donation and
    // the donor double-donates on retry. Same guard earlyAccessPurchase puts around this call.
    try {
      return await checkDonationGoalComplete({
        entityType: goal.entityType,
        entityId: goal.entityId,
      });
    } catch (completionError) {
      logToAxiom({
        type: 'error',
        name: 'donation-goal-complete-after-donate',
        error: completionError,
        donationGoalId,
      }).catch(() => undefined);
      return goal;
    }
  } catch (e) {
    if (performedTransaction) {
      // Refund using multi-account transaction
      try {
        await refundMultiAccountTransaction({
          externalTransactionIdPrefix,
          description: `Refund for failed donation to ${goal.title}`,
        });
      } catch (refundError) {
        console.error('Failed to refund donation transaction:', refundError);
      }
    }
    throw new Error('Failed to create donation');
  }
};

// Entity-agnostic: a goal is addressed by (entityType, entityId) — its phase-2 primary key. Whether
// reaching it unlocks anything is NOT a property of the goal; it's decided here by looking at the
// entity's PaidAccess record. There is no `isEarlyAccess` flag to carry.
export const checkDonationGoalComplete = async ({
  entityType,
  entityId,
}: {
  entityType: PaidAccessEntityType | null;
  entityId: number | null;
}) => {
  if (entityType == null || entityId == null) return null;
  const goal = await donationGoalByEntity({ entityType, entityId });
  if (!goal) return null;

  let endedGate = false;
  if (goal.active && goal.total >= goal.goalAmount) {
    // Goal reached → close it, then end any active *timed* access gate for this entity. Whether
    // donating unlocks access is a property of the PaidAccess record, not the goal (permanent gates
    // never end early on goal completion; entities with no gate simply have nothing to end). The
    // gate-end DB write is fail-closed (propagates): a genuine write failure must surface, not be lost.
    await dbWrite.donationGoal.updateMany({
      where: { entityType, entityId },
      data: { active: false },
    });
    goal.active = false;

    const paidAccess = (await getPaidAccess(entityType, [entityId]))[entityId];
    if (paidAccess && isTimedGateActive(paidAccess)) {
      await endPaidAccessNow(entityType, entityId);
      endedGate = true;
    }
  }

  // Cache busts are fail-open: this runs INSIDE donateToGoal's try AFTER `donation.create` has
  // committed — a throw there refunds the buzz on a persisted donation, so the donor retries and
  // double-donates. A redis blip must serve briefly-stale reads, never propagate. (The DB writes
  // above are legitimate state changes and intentionally stay OUTSIDE this guard.)
  try {
    if (endedGate) {
      await bustPaidAccessCache(entityType, [entityId]);
      await syncModelAfterEarlyGateEnd(entityType, entityId);
    }
    await bustPublicDonationGoalsCache(entityType, entityId);
  } catch (error) {
    logToAxiom({
      type: 'warning',
      name: 'donation-goal-cache-bust-failed',
      error,
      entityType,
      entityId,
    }).catch(() => undefined);
  }

  return goal;
};

// The public donation-goals cache is entity-type-keyed at the cache layer (only ModelVersion has one
// today); route the bust here so the completion flow above stays entity-agnostic.
const bustPublicDonationGoalsCache = async (entityType: PaidAccessEntityType, entityId: number) => {
  if (entityType === 'ModelVersion') await modelVersionPublicDonationGoalsCache.bust(entityId);
};

// A goal-met early end must refresh the model's derived early-access state (feed/card caches + Meili
// re-index) so the now-free model doesn't linger in early-access filters. Natural expiry is handled by
// its own job. Fail-open (runs post-commit — see the guard).
const syncModelAfterEarlyGateEnd = async (entityType: PaidAccessEntityType, entityId: number) => {
  if (entityType !== 'ModelVersion') return;
  const version = await dbRead.modelVersion.findUnique({
    where: { id: entityId },
    select: { modelId: true },
  });
  if (!version) return;
  await queueModelEarlyAccessReindex({ id: version.modelId });
  await bustMvCache(entityId, version.modelId);
  await dataForModelsCache.refresh(version.modelId);
};
