import type { Prisma } from '@prisma/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { getPlacementConfig } from '~/server/services/placement.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import {
  reservedFreeSlots,
  resolvePlacementSpaceFor,
} from '~/server/services/placement-space.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type {
  PlacementSpaceEntity,
  PlacementSpaceMode,
  PlacementSurface,
} from '~/shared/utils/placement';
import {
  FREE_PLACEMENTS_PER_DAY,
  PLACEMENT_SURFACES,
  freePlacementDayStart,
} from '~/shared/utils/placement';

/**
 * A placement made against a creator's free capacity instead of paid for.
 *
 * The whole free path is here rather than branched into each surface, and that
 * is the point of this file: **every refusal the paid path makes, plus the three
 * the free tier adds, in one function**, with the free-tier ones under a lock in
 * the same transaction as the insert. A surface that built its own row and then
 * checked would be a second creation route with the checks bolted on the
 * outside — the guard-versus-filter shape this feature shipped five times in v1.
 *
 * Escrow is bypassed **entirely**, not taken at zero. Zero-amount Buzz
 * transactions are a landmine, and the escrow's two-hold structure has neither a
 * decline fee nor a principal to hold — `holdPlacementEscrow` refuses a free row
 * outright for that reason.
 */

/**
 * Advisory-lock class keys.
 *
 * 🔴 **A free placement takes BOTH, and they must be taken in the order below —
 * placer, then target.** Two callers acquiring them in opposite orders deadlock:
 * A holds the placer lock and waits for the target, B holds the target lock and
 * waits for the placer, and Postgres kills one. That needs two placers claiming
 * at once, so it will not appear in testing and will appear when the feature is
 * finally popular.
 *
 * The same hazard exists against **any** other lock taken inside this
 * transaction, of any arity: a deadlock needs a cycle in the waits-for graph,
 * not a shared key space. Kept unexported alongside the only acquisition site,
 * with a guard test asserting the whole file list, so ordering is not a rule a
 * future caller has to know. If you need a lock here, call `createFreePlacement`
 * rather than export one.
 */
const PLACER_LOCK_CLASS = 0x74ee0001;
const TARGET_LOCK_CLASS = 0x74ee0002;

/**
 * How long a claim will wait for a lock before failing.
 *
 * `pg_advisory_xact_lock` waits forever by default, and Prisma's client-side
 * timeout does not cancel a backend already blocked inside the lock statement.
 * Without a bound, a wedged holder accumulates blocked backends on the write
 * pool rather than failing the claims that are queued behind it.
 *
 * ⚠️ Compiled into the statement below rather than bound as a parameter, because
 * **Postgres has no parameter form for `SET`** — a tagged-template `$executeRaw`
 * sends `$1` and the statement raises `syntax error at or near "$1"`. Every other
 * `SET LOCAL` in this repo uses `$executeRawUnsafe` or a raw `client.query` for
 * the same reason. A module constant, so "unsafe" is about the API's name and not
 * about anything reaching it from a request.
 */
const LOCK_TIMEOUT = '3s';

/**
 * A stable key for one space, hashed into the target lock.
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

type PlacementClient = Pick<typeof dbWrite, 'placement'>;
type SpaceTarget = {
  surface: PlacementSurface;
  targetType: PlacementSpaceEntity;
  targetId: number;
};

/**
 * The daily entitlement, as one predicate.
 *
 * Every status, deliberately: a decline or an expiry gives the image's slot back
 * but NOT the placer's day, because refunding the day turns the free tier into
 * an unlimited retry loop against whoever declines fastest. Every surface, too —
 * the allowance is one placement a day across the site, not one per surface.
 *
 * Written once because the claim decides on it and the UI displays it. Scope it
 * by status later in one of two copies and the surface offers a placement the
 * mutation refuses.
 */
const countFreePlacementsToday = (client: PlacementClient, placerId: number) =>
  client.placement.count({
    where: { placerId, free: true, createdAt: { gte: freePlacementDayStart() } },
  });

/**
 * Never twice on the same target by the same placer, as one predicate.
 *
 * Once ever: not once per day, and not scoped by status. An image posted and
 * deleted daily is otherwise a farm for one account's alts. Scoped to this
 * surface, because placing a sticker and submitting a remix are different acts
 * on the same image and one should not consume the other — and the daily
 * allowance already makes that pair cost two days, so it raises no farm rate.
 *
 * Shared with the display path for the same reason as the daily count.
 */
const countFreePlacementsOn = (
  client: PlacementClient,
  { placerId, surface, targetType, targetId }: SpaceTarget & { placerId: number }
) => client.placement.count({ where: { placerId, free: true, surface, targetType, targetId } });

export type CreateFreePlacement = SpaceTarget & {
  placerId: number;
  /** Who sold the placed thing, when an approval would owe them a cut. */
  sellerId?: number | null;
  /** The surface's own payload. Opaque here, exactly as on the paid path. */
  data: Prisma.InputJsonValue;
};

/**
 * Claims a free slot and creates the placement, or refuses.
 *
 * **The space is resolved here, from the target, rather than passed in.** A
 * caller-supplied space and a separate `targetId` are two facts that can
 * disagree: a caller resolving once and looping would write a placement onto
 * image B carrying image A's owner, so the review queue and every payout
 * attribution would belong to the wrong creator, with nothing raising. Resolving
 * from the one identifier makes that unrepresentable rather than merely
 * unlikely. It costs one extra resolution on a mutation path.
 *
 * **The race is closed by two transaction-scoped advisory locks, not by a unique
 * constraint.** Neither free-tier rule is expressible as one: "at most N held
 * free rows on this target" and "at most one free row for this placer today" are
 * both counts, and Postgres has no partial-unique form for a count. The
 * alternatives were a serializable transaction, which turns a lost race into a
 * retry every caller has to write, and `withDistributedLock`, which returns null
 * rather than running when Redis is down — free placements would then be refused
 * during a Redis outage while the paid path kept working. An advisory lock needs
 * no extra infrastructure, releases on commit or rollback with nothing to leak,
 * and makes count-then-insert atomic without holding a row lock on `Placement`.
 *
 * The placer's own check sits between the two acquisitions on purpose. Taking
 * the shared target lock first would queue every placer who has already spent
 * their day behind a contended lock to learn a fact about nobody but themselves.
 *
 * The deadline is computed BEFORE the transaction opens and written by the same
 * insert. `holdPlacementEscrow` stamps the paid path's deadline in a second
 * statement, and its comment explains what a throw between the two costs: a
 * pending row with a NULL `expiresAt` is never `<= now()`, so the expiry sweep
 * steps over it forever. On the free path that row would also hold one of the
 * creator's slots for good, so there is no window at all.
 */
export async function createFreePlacement({
  surface,
  targetType,
  targetId,
  placerId,
  sellerId,
  data,
}: CreateFreePlacement) {
  const target = { surface, targetType, targetId };
  const space = await resolvePlacementSpaceFor(target);

  // Everything the paid path refuses, refused here too. The free path is not a
  // lighter version of placement — it is placement that costs no Buzz, and every
  // rule about who may place on whom is untouched by the price being zero.
  //
  // Two separate refusals that read as one. `off` is a valid stored mode, so it
  // is IN `allowedModes` — the table says what may be written, not what may be
  // placed into. A mode outside the table is the other case: a gallery row saying
  // `auto` predates the rule that galleries always review, and would otherwise
  // put arbitrary media live unreviewed. Both are refused where the placement is
  // made, not only where the setting is stored.
  const allowedModes = PLACEMENT_SURFACES[surface].allowedModes as readonly PlacementSpaceMode[];
  if (space.mode === 'off' || !allowedModes.includes(space.mode))
    throw throwBadRequestError('placement: this creator is not accepting placements here');

  // Refused rather than allowed-because-it-is-free. On the paid path this is a
  // product decision and not an accounting one — free self-placement would be
  // the creator filling their own slots so nobody else can have them, which
  // defeats the scarcity the whole feature is built on.
  if (space.ownerId === placerId)
    throw throwBadRequestError('placement: you cannot place on your own content');

  if (space.freeSlots <= 0)
    throw throwBadRequestError('placement: this creator is not taking free placements here');

  // Outside the transaction: it is I/O, which `no-io-in-transaction` guards, and
  // it reads the primary so a suspension or a block committed seconds ago
  // refuses rather than being one replica-lag behind.
  //
  // The suspension half is the one the free path could not do without. A block
  // declines the rows pending when it lands; a moderator suspension is the only
  // thing that stops tomorrow's placement, and without this call a suspended
  // placer keeps placing free ones forever.
  await assertCanPlace({ ownerId: space.ownerId, placerId });

  // Read before the transaction opens, for the same no-I/O reason. It falls back
  // to the compiled defaults rather than throwing, so there is no path where
  // this leaves the deadline unset.
  const expiryHours = (await getPlacementConfig()).expiryHours(surface);
  const expiresAt = new Date(Date.now() + expiryHours * 3_600_000);

  return dbWrite.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACER_LOCK_CLASS}::int, ${placerId}::int)`;

    const usedToday = await countFreePlacementsToday(tx, placerId);
    if (usedToday >= FREE_PLACEMENTS_PER_DAY)
      throw throwBadRequestError(
        'placement: you have used your free placement for today. It resets at midnight UTC.'
      );

    // Per (owner, placer), so the placer lock above already serialises it. The
    // paid path's cap, applied here for the same reason: it bounds a review
    // queue an owner can actually work through, and the owner's remedy for the
    // rest is block.
    const pending = await tx.placement.count({
      where: { surface, ownerId: space.ownerId, placerId, status: 'pending' },
    });
    if (pending >= PLACEMENT_SURFACES[surface].maxPendingPerOwner)
      throw throwBadRequestError(
        'placement: you already have the maximum pending placements with this creator'
      );

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TARGET_LOCK_CLASS}::int, hashtext(${spaceLockKey(
      surface,
      targetType,
      targetId
    )}))`;

    const already = await countFreePlacementsOn(tx, { placerId, ...target });
    if (already > 0)
      throw throwBadRequestError(
        `placement: you have already used a free placement here. Free ${PLACEMENT_SURFACES[surface].label} are once per image.`
      );

    // Re-counted inside the lock. `space.freeSlotsRemaining` is what a surface
    // shows someone; this is what decides.
    const reserved = await reservedFreeSlots(tx, target);
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
 * **A listing, not a guard.** It is stale the moment it returns, reads a replica,
 * and the refusal lives in `createFreePlacement` under the lock. Do not gate a
 * mutation on it.
 */
export async function getFreePlacementAllowance({ placerId }: { placerId: number }) {
  const dayStart = freePlacementDayStart();
  const used = await countFreePlacementsToday(dbRead, placerId);

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
export const hasUsedFreePlacementOn = async (input: SpaceTarget & { placerId: number }) =>
  (await countFreePlacementsOn(dbRead, input)) > 0;
