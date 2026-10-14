import { Prisma } from '@prisma/client';
import { TRPCError } from '@trpc/server';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  holdPlacementEscrow,
  isPlacementEscrowFunded,
  LEG_RETRY_BACKOFF_MINUTES,
  settlePlacement,
} from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { getPlacementConfig, placementPriceRange } from '~/server/services/placement.service';
import {
  resolvePlacementSpaceFor,
  setPlacementSpace,
} from '~/server/services/placement-space.service';
import {
  assertCanContinueStoryline,
  writeChapterEdgeForPlacement,
} from '~/server/services/storyline.service';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import type { PlacementSpaceMode, PlacementSpaceSetting } from '~/shared/utils/placement';
import {
  effectivePlacementPrice,
  encodePlacementQueueCursor,
  parsePlacementQueueCursor,
  PLACEMENT_HOLD_KINDS,
  PLACEMENT_QUEUE_PAGE_SIZE,
  PLACEMENT_SURFACES,
  resolvePlacementSpace,
} from '~/shared/utils/placement';
import { storylineLevelAllowed } from '~/shared/utils/storyline';
import type {
  MyStorylineContinuation,
  StorylineContinuationPage,
  StorylineContinuationQueueItem,
  StorylineContinuationStatus,
  StorylineContinuePrice,
  StorylineSpace,
  StorylineSpaceMode,
} from '~/shared/utils/storyline-placement';
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
export type StorylinePlacementData = {
  postId: number;
  /** The post was unfinished at submission. Present only when true. */
  awaitingReadiness?: true;
  /** ISO time the readiness pass admitted it. Absent on a row that never waited. */
  readyAt?: string;
};

/** What the refusals and the readiness check read off a continuation post. */
const continuationPostSelect = {
  userId: true,
  publishedAt: true,
  nsfwLevel: true,
  tosViolation: true,
  storylineChapter: { select: { id: true } },
  images: {
    select: { ingestion: true, tosViolation: true, minor: true, poi: true, needsReview: true },
  },
} satisfies Prisma.PostSelect;

type ContinuationPost = Prisma.PostGetPayload<{ select: typeof continuationPostSelect }>;

/**
 * Where a continuation post stands.
 *
 * `doomed` is a moderation verdict on the post or any image in it and never
 * passes by waiting. `pending` is a state that resolves on its own: not
 * published, scheduled for later, an image still scanning, or no rating yet.
 * `inReview` is a scanned image a moderator has to look at.
 */
export function continuationReadiness(
  post: Pick<ContinuationPost, 'publishedAt' | 'nsfwLevel' | 'tosViolation' | 'images'>,
  now = new Date()
): 'doomed' | 'pending' | 'inReview' | 'ready' {
  if (
    post.tosViolation ||
    post.images.some(
      (image) => image.tosViolation || image.minor || image.poi || image.ingestion === 'Blocked'
    )
  )
    return 'doomed';
  if (
    !post.publishedAt ||
    post.publishedAt > now ||
    !post.images.length ||
    post.images.some((image) => image.ingestion !== 'Scanned') ||
    !post.nsfwLevel
  )
    return 'pending';
  if (post.images.some((image) => image.needsReview != null)) return 'inReview';
  return 'ready';
}

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
 * Complete one as closed. `assertCanContinueStoryline` refuses a block between
 * the placer and the storyline's creator or the chapter's author, and a
 * stranger on a collaborators-only storyline.
 *
 * **An endorsed collaborator's continuation is approved on the spot**, through
 * the same settlement an owner's approval uses, so it writes its chapter edge
 * and stamps `resolvedAt`. If that approval is refused (the edge re-checks the
 * post), the row stays pending for the owner rather than failing the submit.
 *
 * **A post that is not finished yet is accepted and waits.** Unpublished,
 * scheduled, or with an image still scanning: the row carries
 * `awaitingReadiness`, the owner's queue hides it, and
 * `startReadyStorylineContinuations` admits it (or refunds it) once the post
 * is done. Only states that resolve on their own are deferred; a moderation
 * verdict on the post or any of its images refuses here.
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

  const { isCollaborator, parent } = await assertCanContinueStoryline({ parentPostId, placerId });
  const access = storylineContinuationAccess({
    mode: space.mode,
    isCollaborator,
    whoCanContinue: parent.storyline.whoCanContinue,
  });
  // `closed` was refused above, before the assert, so a stranger on a closed
  // storyline hears that it is closed rather than that it is collaborators-only.
  if (access === 'collaboratorsOnly')
    throw throwBadRequestError(STORYLINE_REFUSALS.collaboratorsOnly);

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
    select: continuationPostSelect,
  });
  if (!continuation || continuation.userId !== placerId)
    throw throwBadRequestError(STORYLINE_REFUSALS.notYourPost);

  const readiness = continuationReadiness(continuation);
  if (readiness === 'doomed') throw throwBadRequestError(STORYLINE_REFUSALS.cannotSubmit);
  if (continuation.storylineChapter) throw throwBadRequestError(STORYLINE_REFUSALS.alreadyAChapter);
  // A verdict on a scanned image, the same rule the remix gallery applies. Not
  // deferred: a review can take days, longer than the window to answer.
  if (readiness === 'inReview') throw throwBadRequestError(STORYLINE_REFUSALS.inReview);
  // An unrated post has nothing to compare; the readiness pass compares it.
  if (
    readiness === 'ready' &&
    !storylineLevelAllowed({
      postLevel: continuation.nsfwLevel,
      maxNsfwLevel: parent.storyline.maxNsfwLevel,
    })
  )
    throw throwBadRequestError(STORYLINE_REFUSALS.aboveRating);
  const awaitingReadiness = readiness === 'pending';

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

    // Under the same lock: the post is the placer's own, so a second submit of
    // it can only come from this placer and waits here. Any chapter, not only
    // this one: a post can be a chapter once, anywhere.
    const live = await tx.placement.findFirst({
      where: {
        surface: SURFACE,
        status: { in: ['pending', 'approved'] },
        data: { path: ['postId'], equals: postId },
      },
      select: { id: true },
    });
    if (live) throw throwBadRequestError(STORYLINE_REFUSALS.alreadySubmitted);

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
        data: {
          postId,
          ...(awaitingReadiness ? { awaitingReadiness: true } : {}),
        } satisfies StorylinePlacementData,
      },
      select: { id: true },
    });
  });

  if (amount > 0) await holdOrUnwind({ placementId: placement.id, placerId, amount, spendType });

  // Not until the post is ready: the edge re-checks it and would refuse. The
  // readiness pass approves it then.
  if (access === 'autoApprove' && !awaitingReadiness) await autoApproveContinuation(placement.id);

  return placement;
}

/**
 * Approves an endorsed collaborator's continuation. Never throws: the row is
 * already written and paid for, and a refused approval leaves it pending in the
 * owner's queue, which is the outcome without the endorsement.
 */
async function autoApproveContinuation(placementId: number) {
  await settleStorylineContinuation({ placementId, action: 'approve' }).catch((error) =>
    logToAxiom({
      name: 'storyline-placement',
      type: 'warning',
      message: 'auto-approval refused; left pending for the owner',
      placementId,
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => undefined)
  );
}

async function holdOrUnwind({
  placementId,
  placerId,
  amount,
  spendType,
}: {
  placementId: number;
  placerId: number;
  amount: number;
  spendType: BuzzSpendType;
}) {
  try {
    await holdPlacementEscrow({ placementId, placerId, surface: SURFACE, amount, spendType });
  } catch (error) {
    await settlePlacement({ placementId, action: 'expire' }).catch((settleError) =>
      logToAxiom({
        name: 'storyline-placement',
        type: 'error',
        message: 'compensating settle failed; escrow may be held for a rejected continuation',
        placementId,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      }).catch(() => undefined)
    );
    throw error;
  }
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
      // Locked first, so an answer and the parent's removal take turns: the
      // removal's write waits for this lock, and this read waits for the
      // removal's commit and then sees it.
      if (parentPostId)
        await tx.$queryRaw`SELECT id FROM "StorylineChapter" WHERE "postId" = ${parentPostId} FOR NO KEY UPDATE`;
      const parent = parentPostId
        ? await tx.storylineChapter.findUnique({
            where: { postId: parentPostId },
            select: { removedAt: true, storyline: { select: { userId: true } } },
          })
        : null;
      if (parent && parent.storyline.userId !== pending.ownerId)
        throw new Error(
          `storyline: placement ${placementId} is not owned by its storyline's owner`
        );
      // A removed parent can never take the continuation, so declining it would
      // pay the owner a fee for something they could not accept. It is settled
      // as an expiry instead (`settleContinuationsUnderRemovedChapters`).
      if (parent?.removedAt) throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

      // A decline goes through without a chapter: it writes nothing, and a
      // parent post deleted since must not trap the placer's money in a queue.
      if (action === 'decline') return;

      if (!parentPostId || !postId)
        throw new Error(`storyline: placement ${placementId} does not name a chapter and a post`);
      if (!parent) throw throwBadRequestError(STORYLINE_REFUSALS.notAChapter);

      // The image-level rules the edge does not check. Hidden from the queue
      // is not refused: an owner can still name an unfinished one by id, and an
      // image can be flagged after the row was admitted.
      // `pending` was read before this transaction, so the marker may be stale.
      // That only ever refuses wrongly: the marker is written only by the insert
      // in `createStorylinePlacement` and only cleared, by the guarded update in
      // `startReadyStorylineContinuations`. Anything that sets it on an admitted
      // row must move this check into the status flip's WHERE.
      if ((pending.data as StorylinePlacementData | null)?.awaitingReadiness)
        throw throwBadRequestError(STORYLINE_REFUSALS.notReady);
      const post = await tx.post.findUnique({
        where: { id: postId },
        select: continuationPostSelect,
      });
      const readiness = post ? continuationReadiness(post) : 'doomed';
      if (readiness === 'doomed') throw throwBadRequestError(STORYLINE_REFUSALS.cannotSubmit);
      if (readiness !== 'ready') throw throwBadRequestError(STORYLINE_REFUSALS.notReady);

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

/** True for a refusal (a 400), false for anything that might pass on a retry. */
const isRefusal = (error: unknown) => error instanceof TRPCError && error.code === 'BAD_REQUEST';

const isPositiveId = (id: number | null): id is number => id != null;

/**
 * Admits continuations whose post has since finished, and refunds the ones
 * whose post never will.
 *
 * The rows carry `awaitingReadiness` and are hidden from the owner's queue.
 * Admitting one clears the marker and restarts its clock, for the reason the
 * remix gallery gives: the window before this is the contributor's drafting
 * time, not the owner's time to answer. An endorsed collaborator's is approved
 * here, since the approval had to wait for a finished post.
 *
 * Selected in SQL so a batch holds only rows this pass can act on: a batch of
 * drafts read every tick would starve the rows behind it. A post under review
 * is left out of the selection for the same reason, and refunds at its deadline.
 */
/** What the escrow has receipted for a placement row `pl`, as a SQL expression. */
const receiptedHolds = Prisma.sql`(
  SELECT COALESCE(SUM(t.amount), 0) FROM "PlacementTransaction" t
  WHERE t."placementId" = pl.id
    AND t.kind IN (${Prisma.join([...PLACEMENT_HOLD_KINDS])})
    AND t."transactionId" IS NOT NULL
)`;

export async function startReadyStorylineContinuations({ limit = 200 }: { limit?: number } = {}) {
  const candidates = await dbWrite.$queryRaw<{ id: number }[]>`
    SELECT pl.id
    FROM "Placement" pl
    LEFT JOIN "Post" p ON p.id = (pl.data ->> 'postId')::int
    WHERE pl.surface = ${SURFACE}
      AND pl."targetType" = ${TARGET_TYPE}
      AND pl.status = 'pending'
      AND pl.data ->> 'awaitingReadiness' = 'true'
      -- A priced row whose holds have not all landed is skipped below every
      -- tick; selecting it would let a backlog of them fill the batch and
      -- starve the rows behind. The unfunded sweep settles those.
      AND (pl.amount = 0 OR ${receiptedHolds} >= pl.amount)
      AND (
        p.id IS NULL
        OR p."tosViolation"
        OR EXISTS (
          SELECT 1 FROM "Image" i WHERE i."postId" = p.id
            AND (i."tosViolation" OR i.minor OR i.poi OR i.ingestion = 'Blocked')
        )
        OR (
          p."publishedAt" <= now()
          AND p."nsfwLevel" > 0
          AND EXISTS (SELECT 1 FROM "Image" i WHERE i."postId" = p.id)
          AND NOT EXISTS (
            SELECT 1 FROM "Image" i WHERE i."postId" = p.id
              AND (i.ingestion <> 'Scanned' OR i."needsReview" IS NOT NULL)
          )
        )
      )
    ORDER BY pl.id ASC
    LIMIT ${limit}
  `;
  if (!candidates.length) return { considered: 0, started: 0, refunded: 0 };

  const rows = await dbWrite.placement.findMany({
    where: { id: { in: candidates.map((row) => row.id) }, status: 'pending' },
    select: { id: true, targetId: true, placerId: true, amount: true, data: true },
    orderBy: { id: 'asc' },
  });
  const postIds = rows.map((row) => continuationPostId(row.data)).filter(isPositiveId);
  const posts = new Map(
    (
      await dbWrite.post.findMany({
        where: { id: { in: postIds } },
        select: { id: true, ...continuationPostSelect },
      })
    ).map((post) => [post.id, post])
  );

  const expiryHours = (await getPlacementConfig()).expiryHours(SURFACE);
  let started = 0;
  let refunded = 0;

  // Caught per row: one failed settle must not abort the batch, or the same
  // lowest id is re-read first on every tick and wedges everything behind it.
  const refund = async (placementId: number) => {
    const result = await settlePlacement({ placementId, action: 'expire' }).catch((error) => {
      logToAxiom({
        name: 'storyline-placement',
        type: 'error',
        message: 'readiness refund failed',
        placementId,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
      return null;
    });
    if (result?.settled) refunded++;
  };

  for (const row of rows) {
    // A priced row whose holds are still landing is neither admitted nor
    // refunded: a refund now is planned from the part paid so far, and the hold
    // that lands after it is never returned. Next tick.
    if (
      row.amount > 0 &&
      !(await isPlacementEscrowFunded({ placementId: row.id, amount: row.amount }))
    )
      continue;

    const postId = continuationPostId(row.data);
    const post = postId ? posts.get(postId) : undefined;
    if (!post || !row.targetId) {
      await refund(row.id);
      continue;
    }

    // Decided again here rather than trusting the SQL, which no unit test runs.
    const readiness = continuationReadiness(post);
    if (readiness === 'doomed') {
      await refund(row.id);
      continue;
    }
    if (readiness !== 'ready') continue;

    let access: ReturnType<typeof storylineContinuationAccess>;
    try {
      const [{ isCollaborator, parent }, space] = await Promise.all([
        assertCanContinueStoryline({ parentPostId: row.targetId, placerId: row.placerId }),
        resolvePlacementSpaceFor({
          surface: SURFACE,
          targetType: TARGET_TYPE,
          targetId: row.targetId,
        }),
      ]);
      if (
        !storylineLevelAllowed({
          postLevel: post.nsfwLevel,
          maxNsfwLevel: parent.storyline.maxNsfwLevel,
        })
      ) {
        await refund(row.id);
        continue;
      }
      access = storylineContinuationAccess({
        mode: space.mode,
        isCollaborator,
        whoCanContinue: parent.storyline.whoCanContinue,
      });
    } catch (error) {
      // A refusal (taken down, a block, collaborators only) does not pass by
      // waiting. Anything else might, so the row keeps its deadline and the
      // next tick retries.
      if (isRefusal(error)) await refund(row.id);
      continue;
    }

    // The marker goes in the statement that restarts the clock, and is in the
    // WHERE, so a second pass cannot extend a deadline that is already running.
    const claimed = await dbWrite.placement.updateMany({
      where: { id: row.id, status: 'pending', data: { path: ['awaitingReadiness'], equals: true } },
      data: {
        // When the owner could first see it, for the submitted notification.
        data: {
          postId: post.id,
          readyAt: new Date().toISOString(),
        } satisfies StorylinePlacementData,
        expiresAt: new Date(Date.now() + expiryHours * 3_600_000),
      },
    });
    if (!claimed.count) continue;
    started++;

    if (access === 'autoApprove') await autoApproveContinuation(row.id);
  }

  return { considered: candidates.length, started, refunded };
}

// ---------------------------------------------------------------------------
// Reads and the placer's own actions, for the router
// ---------------------------------------------------------------------------

const toSetting = (
  row: { mode: string; price: number | null } | undefined
): PlacementSpaceSetting | undefined =>
  row ? { mode: row.mode as PlacementSpaceMode, price: row.price } : undefined;

/**
 * A storyline's continuation settings, for its creator.
 *
 * Resolved from the storyline's own row and the creator's account, the cascade
 * a continuation is priced by, without needing a chapter to resolve through.
 * Complete reads as closed, as it does for a contributor.
 */
export async function getStorylineSpace({
  storylineId,
  userId,
}: {
  storylineId: number;
  userId: number;
}): Promise<StorylineSpace> {
  const storyline = await dbWrite.storyline.findUnique({
    where: { id: storylineId },
    select: { userId: true, status: true },
  });
  if (!storyline) throw throwNotFoundError('Storyline not found');
  if (storyline.userId !== userId)
    throw throwAuthorizationError('placement: that is not your storyline');

  const rows = await dbWrite.placementSpace.findMany({
    where: {
      surface: SURFACE,
      OR: [
        { entityType: 'storyline', entityId: storylineId },
        { entityType: 'user', entityId: userId },
      ],
    },
    select: { entityType: true, mode: true, price: true },
  });
  const own = rows.find((row) => row.entityType === 'storyline');
  const resolved = resolvePlacementSpace(SURFACE, {
    storyline: toSetting(own),
    user: toSetting(rows.find((row) => row.entityType === 'user')),
  });
  const { max: cap } = await placementPriceRange(userId, SURFACE);

  return {
    storylineId,
    mode: storyline.status === 'Complete' || resolved.mode !== 'review' ? 'off' : 'review',
    setPrice: own?.price ?? null,
    price: effectivePlacementPrice(resolved.price, cap) ?? 0,
    cap,
    inherited: !own,
  };
}

/** Writes a storyline's own level of the space. `setPlacementSpace` checks ownership. */
export async function setStorylineSpace({
  storylineId,
  mode,
  price,
  userId,
}: {
  storylineId: number;
  mode: StorylineSpaceMode;
  price?: number | null;
  userId: number;
}) {
  await setPlacementSpace({
    surface: SURFACE,
    entityType: 'storyline',
    entityId: storylineId,
    mode,
    price,
    userId,
  });
  return getStorylineSpace({ storylineId, userId });
}

/**
 * Whether THIS viewer may continue a chapter, and at what price.
 *
 * The submission's own checks, so the UI offers only what the server takes. A
 * signed-out viewer is answered as a stranger. A post that is not a chapter of
 * a live storyline is refused outright, as the submission refuses it. The
 * storyline's creator is told `closed`: they add chapters directly, never
 * through a continuation.
 */
export async function getStorylineContinuePrice({
  parentPostId,
  viewerId,
}: {
  parentPostId: number;
  viewerId?: number;
}): Promise<StorylineContinuePrice> {
  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: parentPostId,
  });
  const price = space.price ?? 0;
  const closed = { open: false, closedReason: 'closed', price } as const;
  const collaboratorsOnly = { open: false, closedReason: 'collaboratorsOnly', price } as const;
  if (viewerId != null && viewerId === space.ownerId) return closed;

  let isCollaborator = false;
  let whoCanContinue: StorylineWhoCanContinue | undefined;
  try {
    // 0 for a signed-out viewer: no account has it, so no block or
    // collaborator row matches and they are judged as a stranger.
    const result = await assertCanContinueStoryline({ parentPostId, placerId: viewerId ?? 0 });
    isCollaborator = result.isCollaborator;
    whoCanContinue = result.parent.storyline.whoCanContinue;
  } catch (error) {
    if (!isRefusal(error)) throw error;
    const { message } = error as Error;
    if (message === STORYLINE_REFUSALS.notAChapter) throw error;
    if (message === STORYLINE_REFUSALS.collaboratorsOnly) return collaboratorsOnly;
    // A block between the viewer and the storyline: closed, without saying why.
    return closed;
  }

  const access = storylineContinuationAccess({ mode: space.mode, isCollaborator, whoCanContinue });
  if (access === 'closed') return closed;
  if (access === 'collaboratorsOnly') return collaboratorsOnly;
  return { open: true, closedReason: null, price };
}

const summaryPostSelect = {
  id: true,
  title: true,
  nsfwLevel: true,
  // Only an image that could be shown anywhere: scanned, unflagged, not in
  // review. The owner reviewing is not the image's author.
  images: {
    where: {
      ingestion: 'Scanned',
      tosViolation: false,
      minor: false,
      poi: false,
      needsReview: null,
    },
    // `type` so a video cover is not requested as an image; `hash` and size for its blur.
    select: {
      id: true,
      url: true,
      nsfwLevel: true,
      type: true,
      hash: true,
      width: true,
      height: true,
    },
    orderBy: { index: 'asc' },
    take: 1,
  },
} satisfies Prisma.PostSelect;

/** A post as a queue row shows it. The cover is withheld above what the domain may serve. */
const toPostSummary = (
  post: Prisma.PostGetPayload<{ select: typeof summaryPostSelect }>,
  domainLevels: number
) => {
  const cover = post.images[0];
  return {
    id: post.id,
    title: post.title,
    nsfwLevel: post.nsfwLevel,
    coverImage: cover && (cover.nsfwLevel & domainLevels) !== 0 ? cover : null,
  };
};

/**
 * The storyline creator's review queue: pending continuations, oldest first.
 *
 * A row still waiting on its post's readiness is left out until the readiness
 * pass admits it, as is one whose post has gone, and one continuing a chapter
 * that has been removed (it can no longer be answered, only refunded). Paged in
 * SQL so a page is full of rows the queue can render.
 */
export async function getPendingStorylineContinuations({
  ownerId,
  cursor,
  domainLevels,
  limit = PLACEMENT_QUEUE_PAGE_SIZE,
}: {
  ownerId: number;
  cursor?: string | null;
  /** Levels this domain may serve. A cover above it comes back as `null`. */
  domainLevels: number;
  limit?: number;
}): Promise<StorylineContinuationPage<StorylineContinuationQueueItem>> {
  const keyset = parsePlacementQueueCursor(cursor);
  const listable = await dbRead.$queryRaw<{ id: number; createdAt: Date }[]>`
    SELECT pl.id, pl."createdAt"
    FROM "Placement" pl
    JOIN "Post" p ON p.id = (pl.data ->> 'postId')::int
    WHERE pl.surface = ${SURFACE}
      AND pl."targetType" = ${TARGET_TYPE}
      AND pl."ownerId" = ${ownerId}
      AND pl.status = 'pending'
      AND pl.data ->> 'awaitingReadiness' IS NULL
      AND NOT p."tosViolation"
      AND NOT EXISTS (
        SELECT 1 FROM "StorylineChapter" sc
        WHERE sc."postId" = pl."targetId" AND sc."removedAt" IS NOT NULL
      )
      ${
        keyset
          ? Prisma.sql`AND (pl."createdAt" > ${keyset.createdAt}
              OR (pl."createdAt" = ${keyset.createdAt} AND pl.id > ${keyset.id}))`
          : Prisma.empty
      }
    ORDER BY pl."createdAt" ASC, pl.id ASC
    LIMIT ${limit + 1}
  `;
  const page = listable.slice(0, limit);
  const nextCursor =
    listable.length > limit ? encodePlacementQueueCursor(page[page.length - 1]) : null;
  if (!page.length) return { items: [], nextCursor };

  const rows = await dbRead.placement.findMany({
    where: { id: { in: page.map((row) => row.id) } },
    select: {
      id: true,
      targetId: true,
      amount: true,
      data: true,
      createdAt: true,
      expiresAt: true,
      placer: { select: { id: true, username: true, image: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const postIds = rows.map((row) => continuationPostId(row.data)).filter(isPositiveId);
  const parentIds = rows.map((row) => row.targetId).filter(isPositiveId);

  const [posts, chapters] = await Promise.all([
    dbRead.post.findMany({
      where: { id: { in: [...new Set([...postIds, ...parentIds])] } },
      select: summaryPostSelect,
    }),
    dbRead.storylineChapter.findMany({
      where: { postId: { in: parentIds } },
      select: {
        postId: true,
        storyline: { select: { id: true, title: true, maxNsfwLevel: true } },
      },
    }),
  ]);
  const postById = new Map(posts.map((post) => [post.id, post]));
  const storylineByParent = new Map(chapters.map((chapter) => [chapter.postId, chapter.storyline]));

  const items: StorylineContinuationQueueItem[] = [];
  for (const row of rows) {
    const postId = continuationPostId(row.data);
    const post = postId ? postById.get(postId) : undefined;
    const parentPost = row.targetId ? postById.get(row.targetId) : undefined;
    const storyline = row.targetId ? storylineByParent.get(row.targetId) : undefined;
    if (!post || !parentPost || !storyline) continue;
    items.push({
      id: row.id,
      placer: row.placer,
      amount: row.amount,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      post: toPostSummary(post, domainLevels),
      parentPost: toPostSummary(parentPost, domainLevels),
      storyline,
    });
  }
  return { items, nextCursor };
}

/** The placer's own continuations, newest first. */
export async function getMyStorylineContinuations({
  placerId,
  cursor,
  limit = PLACEMENT_QUEUE_PAGE_SIZE,
}: {
  placerId: number;
  cursor?: string | null;
  limit?: number;
}): Promise<StorylineContinuationPage<MyStorylineContinuation>> {
  const keyset = parsePlacementQueueCursor(cursor);
  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      placerId,
      ...(keyset
        ? {
            OR: [
              { createdAt: { lt: keyset.createdAt } },
              { createdAt: keyset.createdAt, id: { lt: keyset.id } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      status: true,
      amount: true,
      createdAt: true,
      expiresAt: true,
      targetId: true,
      data: true,
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
  });
  const page = rows.slice(0, limit);
  const nextCursor = rows.length > limit ? encodePlacementQueueCursor(page[page.length - 1]) : null;

  const items: MyStorylineContinuation[] = [];
  for (const row of page) {
    const postId = continuationPostId(row.data);
    if (!postId || !row.targetId) continue;
    items.push({
      id: row.id,
      status: row.status as StorylineContinuationStatus,
      amount: row.amount,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      awaitingReadiness: (row.data as StorylinePlacementData).awaitingReadiness === true,
      postId,
      parentPostId: row.targetId,
    });
  }
  return { items, nextCursor };
}

/**
 * The placer withdraws a pending continuation. Settled as an expiry, so a
 * priced one is refunded in full: nobody declined it.
 */
export async function retractStorylineContinuation({
  placementId,
  placerId,
}: {
  placementId: number;
  placerId: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { surface: true, placerId: true, status: true, amount: true },
  });
  if (!placement || placement.surface !== SURFACE)
    throw throwNotFoundError('Continuation not found');
  if (placement.placerId !== placerId) throw throwAuthorizationError();
  if (placement.status !== 'pending')
    throw throwBadRequestError('storyline: this continuation has already been answered');
  // The same race `settleStorylineContinuation` refuses: a refund planned while
  // a hold is landing never returns that hold.
  if (
    placement.amount > 0 &&
    !(await isPlacementEscrowFunded({ placementId, amount: placement.amount }))
  )
    throw throwBadRequestError('storyline: the payment for this continuation is still processing');

  const result = await settlePlacement({ placementId, action: 'expire', actorId: placerId });
  if (!result.settled)
    throw throwBadRequestError('storyline: this continuation has already been answered');
  return { retracted: true };
}

/**
 * How long a priced continuation may sit without all of its holds before it is
 * settled. Submission takes the holds in the same request, each bounded by the
 * Buzz call timeout, so a row this old that is still unfunded was left behind:
 * the request died between writing the row and charging for it.
 */
export const STALE_UNFUNDED_MINUTES = 15;

/**
 * Settles priced continuations whose escrow never filled, as an expiry, so
 * whatever was taken is returned in full and the row leaves the owner's queue
 * and the placer's pending cap.
 *
 * Until settled such a row cannot be answered (approving or declining it waits
 * for the holds) and would otherwise sit there for its whole seven days.
 *
 * A hold attempted within the escrow's retry window may still be in flight, so
 * a row with one is left for a later tick: settling it now would plan the
 * refund from the part receipted so far, and a hold landing afterwards would
 * never be returned. Funding is checked again per row before settling, and the
 * settlement itself only claims a row that is still pending.
 */
export async function settleStaleUnfundedContinuations({ limit = 200 }: { limit?: number } = {}) {
  const stale = await dbWrite.$queryRaw<{ id: number; amount: number }[]>`
    SELECT pl.id, pl.amount
    FROM "Placement" pl
    WHERE pl.surface = ${SURFACE}
      AND pl.status = 'pending'
      AND pl.amount > 0
      AND pl."createdAt" < now() - ${STALE_UNFUNDED_MINUTES} * interval '1 minute'
      AND ${receiptedHolds} < pl.amount
      AND NOT EXISTS (
        SELECT 1 FROM "PlacementTransaction" t
        WHERE t."placementId" = pl.id
          AND t.kind IN (${Prisma.join([...PLACEMENT_HOLD_KINDS])})
          AND t."transactionId" IS NULL
          -- A leg claimed but not yet attempted has no lastAttemptAt; its claim
          -- time stands in, so it is not mistaken for an abandoned one.
          AND COALESCE(t."lastAttemptAt", t."createdAt")
            > now() - ${LEG_RETRY_BACKOFF_MINUTES} * interval '1 minute'
      )
    ORDER BY pl.id ASC
    LIMIT ${limit}
  `;

  let settled = 0;
  for (const row of stale) {
    // Caught per row, so one failure does not wedge the batch on the lowest id.
    try {
      if (await isPlacementEscrowFunded({ placementId: row.id, amount: row.amount })) continue;
      const result = await settlePlacement({ placementId: row.id, action: 'expire' });
      if (result.settled) settled++;
    } catch (error) {
      await logToAxiom({
        name: 'storyline-placement',
        type: 'error',
        message: 'unfunded continuation settle failed',
        placementId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  return { considered: stale.length, settled };
}

/**
 * Settles pending continuations of chapters that have been removed, as an
 * expiry: the placer did nothing wrong, so whatever was taken is returned in
 * full, and the owner, who can no longer accept them, earns no fee.
 *
 * Run right after a takedown with the ids it took down, and by a job for every
 * removed chapter, which finishes what a failed or interrupted run left. The
 * removal itself does not depend on either: from its commit the owner's queue
 * hides these rows and an approval or a decline is refused, so until one of
 * these runs, or the row's own deadline passes, nobody can be paid for it.
 *
 * A priced row whose holds are not all receipted is left alone: settling it
 * would plan the refund from the part paid so far. The unfunded sweep settles
 * it once it is stale. Settling only claims a row that is still pending, so a
 * second run moves no money twice.
 */
export async function settleContinuationsUnderRemovedChapters({
  removedPlacementIds,
  limit = 200,
}: { removedPlacementIds?: number[]; limit?: number } = {}) {
  if (removedPlacementIds && !removedPlacementIds.length) return { considered: 0, settled: 0 };
  const rows = await dbWrite.$queryRaw<{ id: number; amount: number }[]>`
    SELECT pl.id, pl.amount
    FROM "Placement" pl
    JOIN "StorylineChapter" sc ON sc."postId" = pl."targetId"
    WHERE pl.surface = ${SURFACE}
      AND pl."targetType" = ${TARGET_TYPE}
      AND pl.status = 'pending'
      AND sc."removedAt" IS NOT NULL
      ${
        removedPlacementIds
          ? Prisma.sql`AND sc."placementId" IN (${Prisma.join(removedPlacementIds)})`
          : Prisma.empty
      }
    ORDER BY pl.id ASC
    LIMIT ${limit}
  `;

  let settled = 0;
  for (const row of rows) {
    // Caught per row, so one failure does not wedge the batch on the lowest id.
    try {
      if (
        row.amount > 0 &&
        !(await isPlacementEscrowFunded({ placementId: row.id, amount: row.amount }))
      )
        continue;
      const result = await settlePlacement({ placementId: row.id, action: 'expire' });
      if (result.settled) settled++;
    } catch (error) {
      await logToAxiom({
        name: 'storyline-placement',
        type: 'error',
        message: 'continuation under a removed chapter: settle failed',
        placementId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  return { considered: rows.length, settled };
}
