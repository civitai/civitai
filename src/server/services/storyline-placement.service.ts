import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { holdPlacementEscrow, settlePlacement } from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { throwBadRequestError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { PlacementSpaceMode, PlacementTargetType } from '~/shared/utils/placement';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import type { StorylineSpaceMode } from '~/shared/utils/storyline-placement';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const SURFACE = 'storyline' as const;

/**
 * Advisory-lock class for the per-placer pending cap on this surface.
 *
 * The only lock this module takes, and the only one inside its transaction, so
 * there is no ordering to get wrong. Distinct from the free path's classes,
 * which serialise different questions.
 */
const PLACER_LOCK_CLASS = 0x74ee0003;

/** See `LOCK_TIMEOUT` in `free-placement.service.ts`: `SET` has no parameter form. */
const LOCK_TIMEOUT = '3s';

export type CreateStorylinePlacement = {
  placerId: number;
  targetType: PlacementTargetType;
  targetId: number;
  /**
   * What the placer was shown. Refused if the owner has moved it since.
   *
   * Required, unlike the remix gallery's: a storyline is free by default, so a
   * caller that omitted it would let an owner who starts charging mid-decision
   * turn a submission the placer saw as free into a paid one.
   */
  expectedPrice: number;
  /**
   * The domain's currency, decided at the router from the request's own flags.
   * Recorded on a zero-priced row too, so `spendType IS NULL` keeps meaning a
   * row made before the column existed.
   */
  spendType: BuzzSpendType;
  /** The surface's own payload. Opaque here. */
  data: Prisma.InputJsonValue;
};

/**
 * Submits a continuation to a storyline, priced or not.
 *
 * **A zero-priced continuation is an ordinary placement of amount 0, not a free
 * one.** It is written with `free: false`, so it is invisible to both free-tier
 * counts (the placer's daily allowance and the space's reserved slots, which
 * select on `free: true`), and it never calls the escrow, because there is
 * nothing to hold. Settlement handles it with no special case: the payout is
 * computed from receipted holds, a zero-priced row has none, and every leg comes
 * out at zero and is dropped before it is written. The schema comment on
 * `Placement.free` anticipates exactly this row.
 *
 * Every rule about who may place on whom is the same at any price: the mode,
 * self-placement, suspension and blocks, and the per-owner pending cap.
 *
 * **The pending cap is counted under a lock, on both branches.** The other
 * surfaces' paid paths count it without one, and a race there costs the racer
 * real Buzz per extra row. Here a race is free, and the cap is what stands
 * between an owner and an unbounded review queue, so count-then-insert has to be
 * atomic. The lock is per placer: the cap is per (placer, owner) and one placer
 * racing themselves is the whole threat.
 *
 * 🔴 **No router reaches this yet, and none may until it refuses a target that
 * is not a chapter of an open storyline.** The surface defaults to open at zero,
 * which is safe only because a storyline is opt-in by existing; without that
 * refusal every post on the site would accept free continuations into its
 * owner's queue.
 */
export async function createStorylinePlacement({
  placerId,
  targetType,
  targetId,
  expectedPrice,
  spendType,
  data,
}: CreateStorylinePlacement) {
  const space = await resolvePlacementSpaceFor({ surface: SURFACE, targetType, targetId });

  const allowedModes = PLACEMENT_SURFACES[SURFACE].allowedModes as readonly PlacementSpaceMode[];
  if (space.mode === 'off' || !allowedModes.includes(space.mode))
    throw throwBadRequestError(STORYLINE_REFUSALS.notOpen);

  if (space.ownerId === placerId) throw throwBadRequestError(STORYLINE_REFUSALS.ownStoryline);

  // `setPlacementSpace` never writes an open space without a price, and the
  // surface default is 0 rather than null, so this is a hand-edited row.
  if (space.price == null)
    throw throwBadRequestError('storyline: this creator has not set a price yet');

  // Refused rather than charged: a price the placer never saw is a spend without
  // consent. Matters at zero too — an owner who starts charging while someone is
  // deciding must not have the free submission they were shown turn into a
  // paid one.
  if (expectedPrice !== space.price) throw throwBadRequestError(STORYLINE_REFUSALS.priceChanged);

  // Outside the transaction: I/O, and read from the primary.
  await assertCanPlace({ ownerId: space.ownerId, placerId });

  const amount = space.price;
  // Stamped by the insert, so there is no window with a NULL deadline: the
  // expiry sweep selects `expiresAt <= now()`, which NULL never satisfies, and a
  // pending row without one would sit in the owner's queue and the placer's cap
  // forever.
  const expiryHours = (await getPlacementConfig()).expiryHours(SURFACE);
  const expiresAt = new Date(Date.now() + expiryHours * 3_600_000);

  const placement = await dbWrite.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACER_LOCK_CLASS}::int, ${placerId}::int)`;

    const pending = await tx.placement.count({
      where: { surface: SURFACE, ownerId: space.ownerId, placerId, status: 'pending' },
    });
    if (pending >= PLACEMENT_SURFACES[SURFACE].maxPendingPerOwner)
      throw throwBadRequestError(STORYLINE_REFUSALS.pendingCap);

    return tx.placement.create({
      data: {
        surface: SURFACE,
        targetType,
        targetId,
        ownerId: space.ownerId,
        placerId,
        sellerId: null,
        // Never `true`, at any price. See the docblock: `free` is what spends
        // the daily allowance and a slot, and a storyline has neither.
        free: false,
        amount,
        spendType,
        status: 'pending',
        expiresAt,
        data,
      },
      select: { id: true },
    });
  });

  if (amount === 0) return placement;

  try {
    await holdPlacementEscrow({
      placementId: placement.id,
      placerId,
      surface: SURFACE,
      amount,
      spendType,
    });
  } catch (error) {
    await settlePlacement({ placementId: placement.id, action: 'expire' }).catch((settleError) =>
      logToAxiom({
        name: 'storyline-placement',
        type: 'error',
        message: 'compensating settle failed; escrow may be held for a rejected continuation',
        placementId: placement.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      }).catch(() => undefined)
    );
    throw error;
  }

  return placement;
}

/**
 * Opens or closes a storyline to continuations, inside the caller's
 * transaction.
 *
 * For the storyline service, which marks a storyline Complete and closes it in
 * one transaction: the status and the space cannot disagree after a crash.
 * Ownership is the caller's to have checked. Postgres only, through `tx`, so it
 * is safe inside a transaction (`no-io-in-transaction`).
 *
 * Writes the mode alone. A storyline's price stays where its creator left it, so
 * reopening a completed storyline does not reset what it charges.
 *
 * Keyed on the storyline itself (`entityType 'storyline'`): the per-storyline
 * level of the space, above the creator's account default.
 */
export async function setStorylineSpaceMode(
  { storylineId, mode }: { storylineId: number; mode: StorylineSpaceMode },
  tx: Pick<Prisma.TransactionClient, 'placementSpace'>
) {
  // Refused here as well as in the type: `auto` would put arbitrary media on
  // someone's story unreviewed, and a caller casting a string would reach it.
  if (!(PLACEMENT_SURFACES[SURFACE].allowedModes as readonly string[]).includes(mode))
    throw new Error(`storyline: ${mode} is not a mode a storyline may be in`);

  await tx.placementSpace.upsert({
    where: {
      surface_entityType_entityId: {
        surface: SURFACE,
        entityType: 'storyline',
        entityId: storylineId,
      },
    },
    create: { surface: SURFACE, entityType: 'storyline', entityId: storylineId, mode },
    update: { mode },
  });
}
