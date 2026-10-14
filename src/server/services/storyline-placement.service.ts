import type { Prisma } from '@prisma/client';
import { dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  holdPlacementEscrow,
  isPlacementEscrowFunded,
  settlePlacement,
} from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { writeChapterEdgeForPlacement } from '~/server/services/storyline.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { PlacementSpaceMode } from '~/shared/utils/placement';
import { PLACEMENT_SURFACES } from '~/shared/utils/placement';
import type { StorylineSpaceMode } from '~/shared/utils/storyline-placement';
import { STORYLINE_REFUSALS } from '~/shared/utils/storyline-placement';

const SURFACE = 'storyline' as const;
const TARGET_TYPE = 'post' as const;

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
  /** The chapter being continued: the placement's target. */
  parentPostId: number;
  /** The placer's own post, offered as the next chapter. */
  postId: number;
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
};

/** What a storyline placement carries. Storyline and parent come from the target. */
export type StorylinePlacementData = { postId: number };

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
 * The target must be a storyline chapter: resolving the space refuses any
 * other post, which is what keeps a surface that opens at zero by default from
 * opening every post on the site.
 *
 * Resolving the space already refuses a taken-down storyline and reads a
 * Complete one as closed.
 *
 * 🔴 **No router reaches this yet, and none may until it also runs the
 * storyline's remaining checks** (blocks between the placer and the storyline's
 * creator or the chapter's author, collaborators-only) and the continuation
 * post's readiness and rating ceiling.
 */
export async function createStorylinePlacement({
  placerId,
  parentPostId,
  postId,
  expectedPrice,
  spendType,
}: CreateStorylinePlacement) {
  if (postId === parentPostId)
    throw throwBadRequestError('storyline: a chapter cannot continue itself');

  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: parentPostId,
  });

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
  if (expectedPrice !== space.price)
    throw throwBadRequestError(`${STORYLINE_REFUSALS.priceChanged}: now ${space.price} Buzz`);

  // Only your own post can be offered as a chapter: a continuation credits its
  // post's author, so offering someone else's would put your name on their work.
  // Read from the primary, because ownership decides a mutation.
  const continuation = await dbWrite.post.findUnique({
    where: { id: postId },
    select: { userId: true },
  });
  if (!continuation || continuation.userId !== placerId)
    throw throwBadRequestError(STORYLINE_REFUSALS.notYourPost);

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
        targetType: TARGET_TYPE,
        targetId: parentPostId,
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
        data: { postId } satisfies StorylinePlacementData,
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

/** Who may continue a storyline: its own setting, separate from the space's mode. */
export type StorylineWhoCanContinue = 'Anyone' | 'Collaborators';

/**
 * What happens to a continuation from this placer: refused because the
 * storyline is closed, refused because only collaborators may continue it,
 * approved without review because the placer is an endorsed collaborator, or
 * sent to the owner's review.
 *
 * Mode `off` comes first and refuses collaborators too: it is what Complete
 * sets, and a completed storyline takes nothing from anyone. The same answer
 * drives the contributor's `closedReason` and the submission, so the UI cannot
 * offer what the server refuses.
 */
export function storylineContinuationAccess({
  mode,
  isCollaborator,
  whoCanContinue = 'Anyone',
}: {
  mode: PlacementSpaceMode;
  isCollaborator: boolean;
  whoCanContinue?: StorylineWhoCanContinue;
}): 'closed' | 'collaboratorsOnly' | 'autoApprove' | 'review' {
  const allowedModes = PLACEMENT_SURFACES[SURFACE].allowedModes as readonly PlacementSpaceMode[];
  if (mode === 'off' || !allowedModes.includes(mode)) return 'closed';
  if (isCollaborator) return 'autoApprove';
  if (whoCanContinue === 'Collaborators') return 'collaboratorsOnly';
  return 'review';
}

/** The continuation post a storyline placement carries, or null on a malformed row. */
const continuationPostId = (data: Prisma.JsonValue): number | null => {
  const postId =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).postId
      : undefined;
  return typeof postId === 'number' && Number.isInteger(postId) && postId > 0 ? postId : null;
};

/**
 * Approves or declines a pending storyline continuation, once.
 *
 * **An approval writes the chapter edge inside the transaction that flips the
 * placement to approved**, so the two cannot disagree: if the edge is refused
 * (the post is no longer eligible, a block, the storyline taken down), the
 * approval rolls back with it and the placement stays pending for the owner to
 * decline or for expiry to refund. A replay loses the status flip in
 * `settlePlacement` and writes nothing; `writeChapterEdgeForPlacement` is
 * idempotent on the placement id as well.
 *
 * A decline writes no edge. Expiry never comes through here: the generic sweep
 * (`expirePlacements`) settles it with no hook, so it writes none either. Money
 * is the escrow's: a zero-priced continuation holds nothing and every leg is
 * zero; a priced one is settled by the surface's rules like any other.
 */
export async function settleStorylineContinuation({
  placementId,
  action,
  actorId,
}: {
  placementId: number;
  action: 'approve' | 'decline';
  actorId?: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { surface: true, amount: true },
  });
  // Refused rather than settled without the hook: any other surface's approval
  // belongs to its own handler, and a storyline approved without its edge would
  // be paid for and missing from the story.
  if (placement?.surface !== SURFACE)
    throw new Error(`storyline: placement ${placementId} is not a storyline continuation`);

  // The row is committed before its holds are taken, so an owner can see it
  // while they are in flight. Settling then plans the payout from whatever is
  // receipted so far, once, and a hold landing afterwards is charged and never
  // returned. Decline as well as approve: both write that plan.
  if (
    placement.amount > 0 &&
    !(await isPlacementEscrowFunded({ placementId, amount: placement.amount }))
  )
    throw throwBadRequestError('storyline: the payment for this continuation is still processing');

  return settlePlacement({
    placementId,
    action,
    actorId,
    inTransaction: async (tx, pending) => {
      const postId = continuationPostId(pending.data);
      const parentPostId = pending.targetType === 'post' ? pending.targetId : null;

      // Who answers and who is paid (the owner's share, or the decline fee) is
      // `ownerId`; the story is the parent chapter's storyline. They must be the
      // same person, or a chapter's author could accept continuations into, or
      // collect fees from, somebody else's story. Checked in this transaction,
      // whatever the submission path resolved.
      const parent = parentPostId
        ? await tx.storylineChapter.findUnique({
            where: { postId: parentPostId },
            select: { storyline: { select: { userId: true } } },
          })
        : null;
      if (parent && parent.storyline.userId !== pending.ownerId)
        throw new Error(
          `storyline: placement ${placementId} is not owned by its storyline's owner`
        );

      // A decline goes through without a chapter: it writes nothing, and a
      // parent post deleted since must not trap the placer's money in a queue.
      if (action === 'decline') return;

      if (!parentPostId || !postId)
        throw new Error(`storyline: placement ${placementId} does not name a chapter and a post`);
      if (!parent) throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

      await writeChapterEdgeForPlacement(
        { placementId, parentPostId, postId, placerId: pending.placerId },
        tx
      );
    },
  });
}

/**
 * The storyline owner answers a continuation in their queue.
 *
 * Ownership is read off the placement's `ownerId`, which approval also checks
 * against the storyline's owner. Only a pending one can be answered; an
 * already-settled one is refused here so the owner is told, rather than handed
 * the winner's outcome as if theirs had happened.
 */
export async function actOnStorylineContinuation({
  placementId,
  ownerId,
  action,
}: {
  placementId: number;
  ownerId: number;
  action: 'approve' | 'decline';
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { surface: true, ownerId: true, status: true },
  });
  if (!placement || placement.surface !== SURFACE)
    throw throwNotFoundError('Continuation not found');
  if (placement.ownerId !== ownerId) throw throwAuthorizationError();
  if (placement.status !== 'pending')
    throw throwBadRequestError('storyline: this continuation has already been answered');

  const { settled, placement: after } = await settleStorylineContinuation({
    placementId,
    action,
    actorId: ownerId,
  });
  return { settled, status: after.status };
}
