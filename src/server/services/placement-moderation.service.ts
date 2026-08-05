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
  limit = 200,
}: {
  ownerId: number;
  placerId: number;
  limit?: number;
}) {
  const pending = await dbWrite.placement.findMany({
    where: { ownerId, placerId, status: 'pending' },
    select: { id: true },
    take: limit,
  });

  return settleEach(pending, (id) =>
    settlePlacement({ placementId: id, action: 'declineByBlock', actorId: ownerId })
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
  const pending = await dbWrite.placement.findMany({
    where: { placerId, status: 'pending' },
    select: { id: true },
    take: limit,
  });

  const settled = await settleEach(pending, (id) =>
    settlePlacement({ placementId: id, action: 'removeByModerator', actorId })
  );

  // Bounded and resumable: a moderator action over thousands of rows will time
  // out, and running it again has to be safe rather than merely tolerable.
  const { count: takenDown } = await dbWrite.placement.updateMany({
    where: { placerId, status: 'approved' },
    data: {
      status: 'removed',
      removedBy: 'moderator',
      resolvedAt: new Date(),
      resolvedById: actorId,
    },
  });

  return { ...settled, takenDown };
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
