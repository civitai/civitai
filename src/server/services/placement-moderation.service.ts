import { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { settlePlacement } from '~/server/services/placement-escrow.service';

/**
 * Whether either user has blocked the other.
 *
 * **A primary read of the truth table, deliberately — not `getBlockedPairIds`.**
 * That helper reads a Redis cache over a `dbRead` replica, which is right for
 * hiding an affordance in a feed and wrong for guarding a mutation: a block
 * committed seconds earlier would still let a placement through, and the block
 * would be a filter rather than a refusal. Keep the cached helper for the UI and
 * this for the guard; they answer different questions.
 *
 * Bidirectional, because a block should stop placement in both directions —
 * `getBlockedPairIds` already unions both and a one-sided guard here would let
 * someone place on a user who blocked them.
 */
export async function isPlacementBlocked({
  ownerId,
  placerId,
}: {
  ownerId: number;
  placerId: number;
}) {
  const rows = await dbWrite.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM "UserEngagement"
      WHERE type = 'Block'
        AND (("userId" = ${ownerId} AND "targetUserId" = ${placerId})
          OR ("userId" = ${placerId} AND "targetUserId" = ${ownerId}))
    ) AS "exists"
  `;

  return rows[0]?.exists ?? false;
}

/** Also a primary read, for the same reason. */
export async function isPlacementSuspended(userId: number) {
  const suspension = await dbWrite.placementSuspension.findUnique({ where: { userId } });
  return !!suspension;
}

/**
 * The guard the placement mutation must call. Throws rather than returning a
 * boolean the caller might forget to check — v1's most repeated defect was a
 * rule that filtered a listing correctly and never refused the write.
 */
export async function assertCanPlace({ ownerId, placerId }: { ownerId: number; placerId: number }) {
  const [blocked, suspended] = await Promise.all([
    isPlacementBlocked({ ownerId, placerId }),
    isPlacementSuspended(placerId),
  ]);

  if (suspended) throw new Error('placement: your placement privileges are suspended');
  if (blocked) throw new Error('placement: placement is not available on this content');
}

/**
 * How many pending placements a block would decline.
 *
 * **Advisory.** Holding it accurate across a human's confirmation would be a
 * distributed transaction for no benefit; the number that matters is the one the
 * cascade actually declined, which it returns. The underlying race also closes
 * once the block is committed, since `assertCanPlace` reads the primary and no
 * new placement can join the set behind the confirmation.
 */
export const countPendingPlacementsFrom = ({
  ownerId,
  placerId,
}: {
  ownerId: number;
  placerId: number;
}) => dbWrite.placement.count({ where: { ownerId, placerId, status: 'pending' } });

/**
 * Blocking auto-declines every pending placement from that user, fee waived.
 *
 * Approved placements are deliberately left alone: they were accepted, and the
 * spec is explicit that a block is not retroactive. An owner who wants one gone
 * removes it individually, which refunds in full.
 */
export async function declinePlacementsOnBlock({
  ownerId,
  placerId,
  waiveFee,
  limit = 200,
}: {
  ownerId: number;
  placerId: number;
  /**
   * Only when the **owner** did the blocking.
   *
   * The fee is the price of the owner's attention, and an owner refusing to give
   * attention to anyone should not charge for it. But the same cascade also runs
   * in reverse — the blocker's own pending placements on the person they
   * blocked — and waiving there hands the placer a unilateral, repeatable
   * cancel: place ten, let the owner start reviewing, block, get everything
   * back, unblock, repeat. The owner spent the attention either way.
   */
  waiveFee: boolean;
  limit?: number;
}) {
  // The correctness argument for this cascade is that no new placement can join
  // the set behind it, which holds only because `assertCanPlace` reads the
  // primary — and only once the block is actually committed. This module does not
  // write the block, so the precondition is checked rather than assumed.
  if (!(await isPlacementBlocked({ ownerId, placerId })))
    throw new Error('placement: the block must be committed before its placements are declined');

  const pending = await dbWrite.placement.findMany({
    where: { ownerId, placerId, status: 'pending' },
    select: { id: true },
    take: limit,
  });

  return settleEach(pending, (id) =>
    settlePlacement({
      placementId: id,
      action: waiveFee ? 'declineByBlock' : 'decline',
      actorId: ownerId,
    })
  );
}

/**
 * Removes everything a user has placed, sitewide.
 *
 * Pending placements settle through the ordinary path, which forfeits their
 * escrow — the placements were abusive and the Buzz is not returned. Approved
 * ones are **taken down without settlement**: their money was already paid to
 * owners who did nothing wrong, so clawing it back would punish the wrong party.
 *
 * ⚠️ The approved case is provisional pending Justin. It is the reversible
 * choice — it moves no money, so a later decision to claw back or to have the
 * platform absorb it is additive.
 *
 * Reuses `settlePlacement` rather than growing a bulk path that skips the
 * ledger. A second path to a state that already has rules is where every bug in
 * this feature has come from, and "no money moves so the ledger doesn't matter"
 * is exactly how the two would drift.
 */
export async function removePlacementsByUser({
  placerId,
  actorId,
  limit = 200,
}: {
  placerId: number;
  actorId: number;
  limit?: number;
}) {
  // Same shape as the block cascade: without the suspension already committed,
  // the placer can create new placements between the loop and the takedown, or
  // between two bounded runs, and this reports success having missed them.
  if (!(await isPlacementSuspended(placerId)))
    throw new Error('placement: suspend the user before removing their placements');

  const pending = await dbWrite.placement.findMany({
    where: { placerId, status: 'pending' },
    select: { id: true },
    take: limit,
  });

  const settled = await settleEach(pending, (id) =>
    settlePlacement({ placementId: id, action: 'removeByModerator', actorId })
  );

  // Bounded through an id list, because `updateMany` cannot take one: a placer
  // with 50,000 approved placements would otherwise be a single enormous UPDATE
  // holding row locks, rolled back whole by a statement timeout and redone in
  // full on every retry.
  const approved = await dbWrite.placement.findMany({
    where: { placerId, status: 'approved' },
    select: { id: true },
    take: limit,
  });

  const { count: takenDown } = await dbWrite.placement.updateMany({
    where: { id: { in: approved.map((row) => row.id) }, status: 'approved' },
    data: {
      status: 'removed',
      removedBy: 'moderator',
      // Not `resolvedAt`/`resolvedById`: those record who approved it, and this
      // is the one path whose purpose is a moderation record.
      takenDownAt: new Date(),
      takenDownById: actorId,
    },
  });

  return {
    ...settled,
    takenDown,
    hasMore: settled.considered === limit || approved.length === limit,
  };
}

/**
 * One placement, removed by a moderator — the action behind a sticker report.
 *
 * **A live placement cannot go through `settlePlacement` alone.** That claims
 * its transition with `WHERE status = 'pending'`, so an approved row matches
 * nothing, no money moves, and it returns `settled: false` — a moderator would
 * press remove on the reported sticker and watch it stay exactly where it is.
 * Approved placements are taken down by the same write `removePlacementsByUser`
 * uses, for the same reason: their money was already paid to an owner who did
 * nothing wrong, so clawing it back punishes the wrong party.
 *
 * ⚠️ That the approved case moves no money is provisional pending Justin, and
 * is the reversible direction — deciding later to claw back is additive.
 */
export async function removePlacementByModerator({
  placementId,
  actorId,
}: {
  placementId: number;
  actorId: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { id: true, status: true },
  });

  if (!placement) throw new Error('placement: that placement no longer exists');

  if (placement.status === 'pending') {
    const { settled } = await settlePlacement({
      placementId,
      action: 'removeByModerator',
      actorId,
    });
    return { removed: settled, wasLive: false };
  }

  if (placement.status !== 'approved')
    throw new Error(`placement: that placement is already ${placement.status}`);

  const { count } = await dbWrite.placement.updateMany({
    where: { id: placementId, status: 'approved' },
    data: {
      status: 'removed',
      removedBy: 'moderator',
      // Not `resolvedAt`/`resolvedById`: those record who approved it, and this
      // is the one path whose purpose is a moderation record.
      takenDownAt: new Date(),
      takenDownById: actorId,
    },
  });

  return { removed: count > 0, wasLive: true };
}

/**
 * Every placement made with a cosmetic that has been taken down.
 *
 * The third moderator power in the spec, and the one that is about the *maker*
 * rather than the placer: a fine sticker used maliciously is a suspension, while
 * artwork that is itself abusive has to come off everyone's work regardless of
 * who placed it. `revokeCosmeticsFromUsers` strips the holding and un-equips
 * profile decorations; it knows nothing about placements, which live in their
 * own table with the cosmetic id inside a JSON payload.
 *
 * Without this the artwork **stays fully visible** on other people's images
 * after being revoked. Not invisible-but-counted, which is what this comment
 * used to claim and is worth correcting rather than deleting: a takedown never
 * writes the `Cosmetic` row, and `getStickerCosmetics` resolves artwork by id
 * with no join to `UserCosmetic` and no availability check — so revoking every
 * holding changes nothing about what the placement overlay draws. (It does stop
 * the picker offering the sticker and un-equips profile decorations; neither is
 * what this is about.) Reasoning from the old version
 * leads to "we can skip the sweep, it draws nothing anyway", which is exactly
 * backwards.
 *
 * Approved placements are taken down without settlement: the content owner was
 * already paid and did not choose this sticker (Justin, 2026-08-08). Pending
 * ones refund the placer in full, because the placer is a holder of the revoked
 * cosmetic and is being made whole for it everywhere else. Both record
 * `removedBy: 'cosmeticTakedown'` rather than `'moderator'`: a reconcile reading
 * the row has to be able to tell "this placer's sticker was abusive, escrow
 * forfeit" from "the artwork's maker was taken down, placer is a victim", and
 * that distinction decides who gets compensated.
 *
 * **Not scoped to the placers whose holding was revoked, deliberately, and it
 * was tried the other way first.** `revokeCosmeticsFromUsers` scopes a pack to
 * the claim keys it granted, and inheriting that scope here looks fairer: it
 * spares someone who bought a member standalone. It also defeats the function.
 * `UserCosmetic`'s key is `[userId, cosmeticId, claimKey]`, so a holding
 * obtained by any route other than that purchase — above all **the maker's own
 * creator grant** — is not in the scope. The person the takedown exists to stop
 * would be the one person whose placements survived it.
 *
 * There is no third option: a `Placement` records a cosmetic id and nothing
 * about which holding paid for it, and `spendStickerUses` drains across
 * holdings without recording which one funded which placement. Placer identity
 * is a proxy that is wrong in both directions by construction. So the sweep
 * follows the artwork, and the cost is real and accepted: someone who owns the
 * same sticker both inside a taken-down pack and standalone loses all of their
 * placements of it. Pending ones refund in full; approved ones were already
 * paid out to content owners and move no money either way.
 */
export async function removePlacementsByCosmetic({
  cosmeticIds,
  skipIds,
  actorId,
  limit = 200,
}: {
  cosmeticIds: number[];
  /** Rows a previous batch in the same run could not settle — see below. */
  skipIds?: number[];
  actorId: number;
  limit?: number;
}) {
  const empty = { considered: 0, settled: 0, failed: [] as number[], takenDown: 0, hasMore: false };
  const ids = [...new Set(cosmeticIds)];
  if (!ids.length) return empty;

  // Rows that already failed this run are excluded rather than re-selected.
  // `ORDER BY id` is stable, so a permanently failing pending row is picked
  // first by every subsequent batch — 200 of them and the sweep makes zero
  // progress across every iteration of the drain while reporting `hasMore`.
  const skip = skipIds?.length ? [...new Set(skipIds)] : null;

  // Composed as a fragment rather than `(${skip}::int[] IS NULL OR …)`. Whether
  // a JS `null` bound to an array parameter arrives as a castable SQL NULL is a
  // driver behaviour, and this layer's tests mock Prisma, so nothing would
  // execute it before production — where the failure is a throw that fails the
  // sweep closed and leaves the artwork up. An absent filter is not a filter
  // that has to evaluate to true.
  const skipFilter = skip ? Prisma.sql`AND NOT (id = ANY(${skip}::int[]))` : Prisma.empty;

  // Raw, because the cosmetic id lives inside `data` and Prisma's JSON path
  // filter takes one value at a time — a pack takedown revokes several members
  // at once, and one query per member is a query per member.
  const byStatus = (status: string) =>
    dbWrite.$queryRaw<{ id: number }[]>`
      SELECT id FROM "Placement"
      WHERE surface = 'sticker'
        AND status = ${status}
        AND ("data"->>'cosmeticId')::int = ANY(${ids}::int[])
        ${skipFilter}
      ORDER BY id
      LIMIT ${limit}
    `;

  const pending = await byStatus('pending');
  const settled = await settleEach(pending, (id) =>
    settlePlacement({ placementId: id, action: 'removeByCosmeticTakedown', actorId })
  );

  const approved = await byStatus('approved');
  const { count: takenDown } = await dbWrite.placement.updateMany({
    where: { id: { in: approved.map((row) => row.id) }, status: 'approved' },
    data: {
      status: 'removed',
      removedBy: 'cosmeticTakedown',
      takenDownAt: new Date(),
      takenDownById: actorId,
    },
  });

  return {
    ...settled,
    takenDown,
    hasMore: pending.length === limit || approved.length === limit,
  };
}

export async function suspendPlacementPrivileges({
  userId,
  actorId,
  reason,
}: {
  userId: number;
  actorId: number;
  reason?: string;
}) {
  await dbWrite.placementSuspension.upsert({
    where: { userId },
    create: { userId, createdById: actorId, reason },
    update: { createdById: actorId, reason },
  });
}

export const restorePlacementPrivileges = (userId: number) =>
  dbWrite.placementSuspension.deleteMany({ where: { userId } });

async function settleEach(
  rows: { id: number }[],
  settle: (id: number) => Promise<{ settled: boolean }>
) {
  let settled = 0;
  const failed: number[] = [];

  for (const { id } of rows) {
    try {
      const result = await settle(id);
      if (result.settled) settled++;
    } catch (error) {
      failed.push(id);
      logToAxiom({
        name: 'placement-moderation',
        type: 'error',
        message: 'placement could not be settled',
        placementId: id,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { considered: rows.length, settled, failed };
}
