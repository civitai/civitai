import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { getPlacementConfig } from '~/server/services/placement.service';
import type { ResolvedPlacementSpace } from '~/server/services/placement-space.service';
import { reservedFreeSlots } from '~/server/services/placement-space.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { PlacementSpaceEntity, PlacementSurface } from '~/shared/utils/placement';
import {
  FREE_PLACEMENTS_PER_DAY,
  PLACEMENT_SURFACES,
  freePlacementDayStart,
} from '~/shared/utils/placement';

/**
 * A placement made against a creator's free capacity instead of paid for.
 *
 * The whole free path is here rather than branched into each surface, and that
 * is the point of this file: three refusals — capacity, the daily allowance, and
 * never twice on the same target — have to hold together, under a lock, in the
 * same transaction as the insert. A surface that built its own row and then
 * checked would be a second creation route with the checks bolted on the
 * outside, which is where the free tier stops being scarce.
 *
 * Escrow is bypassed **entirely**, not taken at zero. Zero-amount Buzz
 * transactions are a landmine, and the escrow's two-hold structure has neither a
 * decline fee nor a principal to hold — `holdPlacementEscrow` refuses a free row
 * outright for that reason.
 */

/**
 * Advisory-lock class keys.
 *
 * 🔴 **A free placement takes BOTH of these, and every caller must take them in
 * the order below — placer, then target.** Two callers acquiring them in
 * opposite orders deadlock: A holds the placer lock and waits for the target,
 * B holds the target lock and waits for the placer, and Postgres kills one of
 * them. That only happens when two placers are claiming at once, which is when
 * the feature is finally popular — so it will not show up in testing, and it
 * will show up on the day it costs the most.
 *
 * Kept unexported, alongside the only two acquisitions in the codebase, so
 * "obey the order" is not a rule a future caller has to know: there is nowhere
 * else to take them from. A guard test asserts that stays true. If you find
 * yourself needing one of these somewhere else, the answer is to call
 * `createFreePlacement` rather than to export a lock.
 *
 * Two-argument advisory locks occupy a lock space distinct from the
 * one-argument form, so these cannot collide with `article.service.ts`'s
 * bare-id locks however its ids grow.
 */
const PLACER_LOCK_CLASS = 0x74ee0001;
const TARGET_LOCK_CLASS = 0x74ee0002;

/**
 * A stable key for one space, hashed into the lock below.
 *
 * The surface is in it because the same image id is a valid target on both
 * surfaces, and locking on the id alone would serialise a sticker placement
 * behind an unrelated remix submission. Hash collisions are possible and
 * harmless — two unrelated spaces sharing one serialise with each other, which
 * costs a little contention and no correctness.
 */
const spaceLockKey = (
  surface: PlacementSurface,
  targetType: PlacementSpaceEntity,
  targetId: number
) => `${surface}:${targetType}:${targetId}`;

export type CreateFreePlacement = {
  surface: PlacementSurface;
  targetType: PlacementSpaceEntity;
  targetId: number;
  placerId: number;
  /**
   * The space as `resolvePlacementSpaceFor` returned it, carried whole rather
   * than as a handful of extracted numbers. The caller has already resolved it
   * to check the mode and the owner, and passing the object means the owner and
   * the capacity cannot arrive from two different resolutions of the same space.
   *
   * ⚠️ `freeSlotsRemaining` on it is NOT what this decides on — it was computed
   * before the caller's other checks ran and is stale by the time it gets here.
   * Only `freeSlots`, the capacity, is read; the reservation is re-counted under
   * the lock.
   */
  space: ResolvedPlacementSpace;
  /** Who sold the placed thing, when an approval would owe them a cut. */
  sellerId?: number | null;
  /** The surface's own payload. Opaque here, exactly as on the paid path. */
  data: Prisma.InputJsonValue;
};

/**
 * Claims a free slot and creates the placement, or refuses.
 *
 * **The race is closed by two transaction-scoped advisory locks, not by a unique
 * constraint.** Neither rule this enforces is expressible as one: "at most N
 * pending-or-approved free rows for this target" and "at most one free row for
 * this placer today" are both counts, and Postgres has no partial-unique form
 * for a count. The alternatives were a serializable transaction, which turns a
 * lost race into a retry the caller has to write, and `withDistributedLock`,
 * which returns null rather than running when Redis is down — a free placement
 * would then be refused during a Redis outage while the paid path kept working.
 * An advisory lock needs no extra infrastructure, releases on commit or rollback
 * with nothing to leak, and makes count-then-insert atomic without anyone
 * holding a row lock on `Placement`.
 *
 * Both locks are taken in a fixed order — placer, then target — because a
 * placement takes both, and two callers acquiring them in opposite orders is the
 * textbook deadlock. The order is arbitrary; that it is the same everywhere is
 * not.
 *
 * The deadline is computed BEFORE the transaction opens and written by the same
 * insert. `holdPlacementEscrow` stamps the paid path's deadline in a second
 * statement, and its comment explains what a throw between the two costs: a
 * pending row with a NULL `expiresAt` is never `<= now()`, so the expiry sweep
 * steps over it forever. On the free path that row would also hold one of the
 * creator's slots for good, so there is no window at all — one statement, one
 * row, deadline included.
 */
export async function createFreePlacement({
  surface,
  targetType,
  targetId,
  placerId,
  space,
  sellerId,
  data,
}: CreateFreePlacement) {
  if (space.freeSlots <= 0)
    throw throwBadRequestError('placement: this creator is not taking free placements here');

  // Read before the transaction opens: `getPlacementConfig` touches KeyValue, and
  // I/O inside a transaction is a repo rule with its own lint guard. It falls
  // back to the compiled defaults on its own rather than throwing, so there is no
  // path where this leaves the deadline unset.
  const expiryHours = (await getPlacementConfig()).expiryHours(surface);
  const expiresAt = new Date(Date.now() + expiryHours * 3_600_000);

  return dbWrite.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACER_LOCK_CLASS}::int, ${placerId}::int)`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TARGET_LOCK_CLASS}::int, hashtext(${spaceLockKey(
      surface,
      targetType,
      targetId
    )}))`;

    // Every status, deliberately. A decline or an expiry gives the image's slot
    // back but NOT the placer's day — refunding the day would turn the free tier
    // into an unlimited retry loop against whoever declines fastest.
    const usedToday = await tx.placement.count({
      where: { placerId, free: true, createdAt: { gte: freePlacementDayStart() } },
    });
    if (usedToday >= FREE_PLACEMENTS_PER_DAY)
      throw throwBadRequestError(
        'placement: you have used your free placement for today. It resets at midnight UTC.'
      );

    // Once ever: not once per day, and not scoped by status. An image posted and
    // deleted daily is otherwise a farm for one account's alts. Scoped to this
    // surface, because placing a sticker and submitting a remix are different
    // acts on the same image and one should not consume the other.
    const already = await tx.placement.count({
      where: { placerId, free: true, surface, targetType, targetId },
    });
    if (already > 0)
      throw throwBadRequestError(
        `placement: you have already used a free placement here. Free ${PLACEMENT_SURFACES[surface].label} are once per image.`
      );

    // Re-counted inside the lock. `space.freeSlotsRemaining` is what the caller
    // showed someone; this is what decides.
    const reserved = await reservedFreeSlots(tx as typeof dbWrite, {
      surface,
      targetType,
      targetId,
    });
    if (reserved >= space.freeSlots)
      throw throwBadRequestError('placement: the free slots on this one are taken');

    return tx.placement.create({
      data: {
        surface,
        targetType,
        targetId,
        ownerId: space.ownerId,
        placerId,
        sellerId: sellerId ?? null,
        free: true,
        // Zero, and the DB enforces it. Nothing sizes a payout from this — the
        // money path reads receipted holds, of which there are none — but every
        // report and every support answer quotes it, and a free placement
        // carrying a price says a creator earned something they did not.
        amount: 0,
        status: 'pending',
        expiresAt,
        data,
      },
      select: { id: true },
    });
  });
}

/**
 * Where a placer stands against their daily allowance.
 *
 * For surfaces that need to say so before someone commits — the free/paid choice
 * is worth making with the number visible, and an allowance spent silently is
 * the worst version of a scarce thing.
 *
 * **A listing, not a guard.** It is stale the moment it returns, and the refusal
 * lives in `createFreePlacement` under the lock. Do not gate a mutation on it.
 */
export async function getFreePlacementAllowance({ placerId }: { placerId: number }) {
  const dayStart = freePlacementDayStart();
  const used = await dbWrite.placement.count({
    where: { placerId, free: true, createdAt: { gte: dayStart } },
  });

  return {
    used,
    remaining: Math.max(FREE_PLACEMENTS_PER_DAY - used, 0),
    /** Midnight UTC ending the current day, when the allowance comes back. */
    resetsAt: new Date(dayStart.getTime() + 24 * 3_600_000),
  };
}

/**
 * Whether this placer has already spent a free placement on this target.
 *
 * Same standing as the allowance above: a listing for the surface to render,
 * never the thing a mutation decides on.
 */
export async function hasUsedFreePlacementOn({
  placerId,
  surface,
  targetType,
  targetId,
}: {
  placerId: number;
  surface: PlacementSurface;
  targetType: PlacementSpaceEntity;
  targetId: number;
}) {
  const count = await dbWrite.placement.count({
    where: { placerId, free: true, surface, targetType, targetId },
  });
  return count > 0;
}
