import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import {
  holdPlacementEscrow,
  settlePlacement,
  MAX_LEG_ATTEMPTS,
} from '~/server/services/placement-escrow.service';
import { recordPlacementTip } from '~/server/services/placement-metrics.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { spendStickerUsesFor } from '~/server/services/sticker.service';
import { userWithCosmeticsSelect } from '~/server/selectors/user.selector';
import {
  throwAuthorizationError,
  throwBadRequestError,
  throwNotFoundError,
} from '~/server/utils/errorHandling';
import type { PlacementStatus } from '~/shared/utils/placement';
import type {
  PlacementSettlementState,
  StickerPlacementData,
} from '~/shared/utils/sticker-placement';
import {
  isStickerPlacementData,
  normalizeStickerComment,
  normalizeStickerPlacement,
  stickerMaxScale,
  stickerRemovableAt,
} from '~/shared/utils/sticker-placement';

const SURFACE = 'sticker' as const;
const TARGET_TYPE = 'image' as const;

/**
 * How many pending placements one placer may have waiting on one owner.
 *
 * A cap rather than a rate limit: the cost is already real Buzz, so this is not
 * about spam economics but about a review queue an owner can actually work
 * through. Their remedy for the rest is block, which declines all of them.
 */
const MAX_PENDING_PER_OWNER = 10;

/**
 * The note on a placement, if this viewer may read it.
 *
 * A hidden note stays readable to the three parties who have a reason to see it
 * — the owner who hid it, the placer who wrote and paid for it, and a moderator
 * acting on a report about it — and to nobody else. Hiding is the owner's
 * judgement about their own image, not a deletion: the text is what a report is
 * about, so a moderator opening one must be able to see what was said.
 *
 * Both fields are re-checked here rather than trusted from the payload.
 * `isStickerPlacementData` validates the geometry and stops there, which is
 * right — a row with a malformed note should still draw its sticker — so this
 * is the boundary where the note has to prove it is a string. `commentHidden`
 * is compared against `true` for the same reason: a hand-edited `"false"` is
 * truthy, and would hide a note nobody refused.
 */
const visibleStickerComment = (data: StickerPlacementData, isParty: boolean) => {
  if (typeof data.comment !== 'string' || !data.comment) return undefined;
  return data.commentHidden === true && !isParty ? undefined : data.comment;
};

/** The lock's expiry, or `null` once it has already passed. */
const nextRemovableAt = (approvedAt: Date) => {
  const removableAt = stickerRemovableAt(approvedAt);
  return removableAt > new Date() ? removableAt : null;
};

/**
 * The sticker the placer chose, from the primary, with ownership resolved.
 *
 * `userOwnedStickerCache` is a Redis cache over a `dbRead` replica. That is the
 * right thing for deciding whether to show a sticker in the picker and the wrong
 * thing here — this is a mutation guard, and a revocation committed seconds ago
 * must refuse rather than be filtered out one render later. Same distinction as
 * `assertCanPlace` versus `getBlockedPairIds`; keep both.
 */
async function loadPlaceableSticker({
  cosmeticId,
  placerId,
}: {
  cosmeticId: number;
  placerId: number;
}) {
  const [cosmetic] = await dbWrite.$queryRaw<
    { id: number; createdById: number | null; owned: boolean }[]
  >`
    SELECT c.id, c."createdById",
           EXISTS (
             SELECT 1 FROM "UserCosmetic" uc
             WHERE uc."cosmeticId" = c.id AND uc."userId" = ${placerId}
           ) AS owned
    FROM "Cosmetic" c
    WHERE c.id = ${cosmeticId} AND c.type = 'Sticker'::"CosmeticType"
  `;

  if (!cosmetic) throw throwBadRequestError('placement: that sticker no longer exists');
  if (!cosmetic.owned) throw throwAuthorizationError('placement: you do not own that sticker');

  return cosmetic;
}

export type CreateStickerPlacement = {
  placerId: number;
  imageId: number;
  data: Omit<StickerPlacementData, 'cosmeticId'> & { cosmeticId: number };
  /** Moderators may exceed a creator's size limit. Justin's call. */
  isModerator?: boolean;
};

/**
 * A placer's optional note travels with the placement it belongs to.
 *
 * Not a `CommentV2` thread: this is one immutable line bought with the
 * placement, and giving it the comment system's identity would give it that
 * system's edit, reply and notification behaviour — none of which anyone asked
 * for, all of which would then need their own answer to "the owner accepted the
 * sticker and refused the note".
 */
const commentFrom = (data: { comment?: string | null }) => normalizeStickerComment(data.comment);

/**
 * Places a sticker on an image, charging a use and the owner's price.
 *
 * Every guard here refuses on the mutation. A listing that filters is not a
 * mutation that refuses, and v1 shipped that mistake five times.
 *
 * **Ordering, which is the whole design of this function:**
 *
 * The placement row has to be committed before the escrow can be taken — its id
 * is a parameter to the hold, and the hold's ledger rows carry a foreign key to
 * it. So "create and hold in one transaction" is not available, and threading a
 * transaction through would be worse: it would put a Buzz call inside an open
 * Prisma transaction, and the hold's claim rows are *designed* to outlive the
 * caller so the sweeper can finish what a crash interrupted. Rolling them back
 * destroys the evidence recovery depends on.
 *
 * So the row is created, the escrow is taken, and anything that throws after the
 * row exists expires it. Expiry refunds both holds in full through real refunds
 * of real holds, so a partial hold reverses in the exact currency mix it was
 * drawn from, and the row lands in a terminal state nobody sees. If that
 * compensating settle also fails — Buzz still down — `holdPlacementEscrow` has
 * already stamped `expiresAt`, so the expiry job reaches it anyway.
 *
 * The use is spent *after* the escrow lands, so a failed charge cannot consume
 * one. The pre-check below is a courtesy refusal; the spend is the authority,
 * and it is all-or-nothing under `FOR UPDATE`.
 */
export async function createStickerPlacement({
  placerId,
  imageId,
  data,
  isModerator = false,
}: CreateStickerPlacement) {
  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: imageId,
  });

  if (space.mode === 'off')
    throw throwBadRequestError('placement: this creator is not accepting stickers here');

  // Placing on your own content would charge you and pay you, minus the
  // platform's cut — a fee for decorating your own image. Refused rather than
  // priced at zero: free self-placement is a product decision, and allowing it
  // later is additive where charging for it wrongly is not.
  if (space.ownerId === placerId)
    throw throwBadRequestError('placement: you cannot place a sticker on your own content');

  if (space.price == null)
    throw throwBadRequestError('placement: this creator has not set a price yet');

  // The creator's size limit, refused rather than clamped. Quietly shrinking a
  // sticker someone just paid for is the same shape as v1's recurring defect: a
  // rule applied as a filter where a refusal was needed. The editor also caps
  // its handles, so reaching this means the limit moved or the request did not
  // come from the editor.
  //
  // Not applied retroactively — existing placements were accepted at the size
  // they were accepted at, and a creator lowering their limit is not a licence
  // to take back something already paid for.
  const maxScale = stickerMaxScale(space.settings);
  if (!isModerator && data.scale > maxScale)
    throw throwBadRequestError(
      `placement: this creator allows stickers up to ${Math.round(
        maxScale * 100
      )}% of the image width`
    );

  await assertCanPlace({ ownerId: space.ownerId, placerId });

  const pending = await dbWrite.placement.count({
    where: { surface: SURFACE, ownerId: space.ownerId, placerId, status: 'pending' },
  });
  if (pending >= MAX_PENDING_PER_OWNER)
    throw throwBadRequestError(
      'placement: you already have the maximum pending placements with this creator'
    );

  const sticker = await loadPlaceableSticker({ cosmeticId: data.cosmeticId, placerId });
  await assertHasUse({ userId: placerId, cosmeticId: sticker.id });

  const comment = commentFrom(data);

  const placement = await dbWrite.placement.create({
    data: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: imageId,
      ownerId: space.ownerId,
      placerId,
      // The seller lives on the row rather than being passed to settlement,
      // which is resumable: a sweeper that never saw the argument would strand
      // their share with no record anyone was owed.
      sellerId: sticker.createdById,
      amount: space.price,
      status: 'pending',
      data: {
        cosmeticId: sticker.id,
        ...normalizeStickerPlacement(data),
        // Omitted rather than stored as an empty string, so "left the field
        // blank" and "wrote nothing but spaces" are the same row.
        ...(comment ? { comment } : {}),
      },
    },
    select: { id: true },
  });

  try {
    await holdPlacementEscrow({
      placementId: placement.id,
      placerId,
      surface: SURFACE,
      amount: space.price,
    });

    await spendStickerUsesFor({ userId: placerId, counts: new Map([[sticker.id, 1]]) });
  } catch (error) {
    await settlePlacement({ placementId: placement.id, action: 'expire' }).catch((settleError) =>
      // Not swallowed silently: the row still has a deadline, so the expiry job
      // will reach it, but a compensating settle that fails means Buzz is held
      // for a placement the user was told failed.
      logToAxiom({
        name: 'sticker-placement',
        type: 'error',
        message: 'could not unwind a placement whose escrow failed',
        placementId: placement.id,
        error: (settleError as Error).message,
      }).catch(() => null)
    );
    throw error;
  }

  // `auto` settles immediately, which is what makes the placement live. `review`
  // leaves it pending, visible only to its placer, until the owner acts.
  if (space.mode === 'auto') {
    const { settled } = await settlePlacement({
      placementId: placement.id,
      action: 'approve',
      actorId: space.ownerId,
    });
    // Gated on the settle actually claiming the transition, not on reaching this
    // line: `settlePlacement` returns `settled: false` when something else got
    // there first, and counting then would add the placement's Buzz to the image
    // twice for one payment.
    if (settled)
      await recordPlacementTip({ surface: SURFACE, imageId, amount: space.price, placerId });
  }

  return { placementId: placement.id, status: space.mode === 'auto' ? 'approved' : 'pending' };
}

/**
 * A courtesy refusal before any money moves. The spend after the escrow is the
 * authority — this only exists so "you're out of uses" arrives before a charge
 * and a refund rather than as a surprising round trip.
 */
async function assertHasUse({ userId, cosmeticId }: { userId: number; cosmeticId: number }) {
  const [balance] = await dbWrite.$queryRaw<{ spendable: number | null; unlimited: boolean }[]>`
    SELECT SUM("remaining")::int AS spendable, bool_or("remaining" IS NULL) AS unlimited
    FROM "UserCosmetic"
    WHERE "userId" = ${userId} AND "cosmeticId" = ${cosmeticId}
  `;

  if (!balance?.unlimited && (balance?.spendable ?? 0) < 1)
    throw throwBadRequestError(
      "You don't have any uses left on that sticker. Buy more to keep placing it."
    );
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type StickerPlacementView = {
  id: number;
  imageId: number;
  placerId: number;
  ownerId: number;
  status: PlacementStatus;
  amount: number;
  data: StickerPlacementData;
  /**
   * When it was placed, which is what decides what covers what — and, on the
   * detail view, the order and the pacing of the reveal. Carried on the listing
   * rather than left to `getStickerPlacementDetail`: a client that has to ask
   * per placement cannot order them until every one of those queries lands, so
   * the layer order would settle after paint.
   */
  placedAt: Date;
  /** True only for the placer's own placement awaiting the owner. */
  isPending: boolean;
  /** Whether this placement carries a note the viewer may read. */
  hasComment: boolean;
};

/**
 * Who placed one sticker, and when.
 *
 * Its own query rather than a wider `getStickerPlacements`: that one runs for
 * every image on a feed page, and joining a user onto every placement would pay
 * for the hover card on every sticker nobody hovers.
 *
 * The visibility rule is repeated here on purpose. It matches
 * `getStickerPlacements`, but a caller reaching this with an id it guessed has
 * not been through that query, so leaving the check to the listing would make
 * every pending placement's placer readable by anyone who could count.
 */
export async function getStickerPlacementDetail({
  placementId,
  viewerId,
  isModerator = false,
}: {
  placementId: number;
  viewerId?: number;
  /**
   * A moderator is party to neither side of a pending placement, so the scoping
   * below hides it from the only role that can act on it — and the surfaces
   * built on this read then say "no longer live" about something that is
   * pending, with no action offered. Widened for moderators specifically rather
   * than loosened for everyone: the rule that a pending placement is visible to
   * exactly the placer and the owner is what stops it being enumerable.
   *
   * **Widened to the other live status, not to every status.** Dropping the
   * filter would also return declined, expired and removed rows, and every
   * consumer reads a miss here as "this placement is already gone" — so a
   * second moderator opening a report someone else has already actioned would
   * be offered a remove button for a removed placement, told no Buzz moves,
   * and handed an error when they pressed it.
   */
  isModerator?: boolean;
}) {
  const placement = await dbRead.placement.findFirst({
    where: {
      id: placementId,
      surface: SURFACE,
      OR: isModerator
        ? [{ status: 'approved' }, { status: 'pending' }]
        : [
            { status: 'approved' },
            ...(viewerId
              ? [
                  { status: 'pending' as const, placerId: viewerId },
                  { status: 'pending' as const, ownerId: viewerId },
                ]
              : []),
          ],
    },
    select: {
      id: true,
      createdAt: true,
      resolvedAt: true,
      status: true,
      data: true,
      ownerId: true,
      placerId: true,
      placer: { select: userWithCosmeticsSelect },
    },
  });

  if (!placement) throw throwNotFoundError('placement: that placement is not available');

  // Read off the placement's own payload rather than joined in the query above:
  // `data` is JSON, so the cosmetic id is not a relation Prisma can follow.
  const data = isStickerPlacementData(placement.data)
    ? (placement.data as StickerPlacementData)
    : null;
  const cosmeticId = data?.cosmeticId ?? null;

  const isParty =
    isModerator ||
    (!!viewerId && (viewerId === placement.ownerId || viewerId === placement.placerId));

  const cosmetic = cosmeticId
    ? await dbRead.cosmetic.findUnique({
        where: { id: cosmeticId },
        select: { id: true, name: true, creator: { select: { id: true, username: true } } },
      })
    : null;

  return {
    id: placement.id,
    // When they placed it, not when it was approved: the question the card
    // answers is who put this here and when, and an owner sitting on a review
    // queue for two days did not change that.
    placedAt: placement.createdAt,
    status: placement.status as PlacementStatus,
    placer: placement.placer,
    comment: data ? visibleStickerComment(data, isParty) ?? null : null,
    /**
     * Whether this viewer owns the content, so the card can offer the controls
     * that belong to the owner. Emitted as the answer rather than as `ownerId`
     * for the caller to compare: the id is not otherwise on this card, and a
     * page that has it will eventually compare it somewhere the server does not.
     */
    viewerIsOwner: !!viewerId && viewerId === placement.ownerId,
    /**
     * Whether the note is currently refused — for the owner whose control it
     * labels and the placer who would otherwise think their note was live.
     *
     * `false` for everyone else rather than the truth. A stranger has nothing to
     * do with the answer, and a hover card that draws no text but says a note
     * was refused tells them a note existed and how the owner judged it, which
     * is the fact withholding the text was protecting.
     */
    commentHidden: isParty && !!data?.commentHidden,
    /**
     * When the owner may take this off, so the button can be disabled with a
     * date rather than refusing after the click. `null` once the lock has run
     * out, for anything not live, and for anyone but the owner — nobody else has
     * a control it explains, and it is the only field here that would tell a
     * stranger when the owner approved. The server refuses independently: this
     * is what the UI says, not what decides it.
     */
    removableAt:
      placement.status === 'approved' && viewerId === placement.ownerId
        ? nextRemovableAt(placement.resolvedAt ?? placement.createdAt)
        : null,
    sticker: cosmetic
      ? {
          id: cosmetic.id,
          name: cosmetic.name,
          // The link, not the ingredients. `username` is nullable — `deleteUser`
          // soft-deletes and nulls it — and a template literal accepts null
          // silently, which is how `/user/null/shop` shipped past a typecheck.
          // Emitting the href means no consumer can build the wrong one, because
          // none of them build one.
          creatorName: cosmetic.creator?.username ?? null,
          shopHref: cosmetic.creator?.username ? `/user/${cosmetic.creator.username}/shop` : null,
        }
      : null,
  };
}

/**
 * Approved placements for a set of images, plus the viewer's own pending ones.
 *
 * The pending row is deliberately in the same payload rather than a second call:
 * the placer sees their own submission rendered faint while it waits, and
 * nobody else sees it at all. Splitting it into its own query is how a surface
 * ends up rendering someone else's pending placement on a page that forgot to
 * filter.
 */
export async function getStickerPlacements({
  imageIds,
  viewerId,
}: {
  imageIds: number[];
  viewerId?: number;
}): Promise<StickerPlacementView[]> {
  if (!imageIds.length) return [];

  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: { in: imageIds },
      OR: [
        { status: 'approved' },
        // A pending placement is visible to exactly two people: the one who paid
        // for it, and the one being asked to accept it. Without both ids scoped
        // this becomes "everyone sees every pending placement", which is the
        // feature working in reverse.
        ...(viewerId
          ? [
              { status: 'pending' as const, placerId: viewerId },
              { status: 'pending' as const, ownerId: viewerId },
            ]
          : []),
      ],
    },
    select: {
      id: true,
      targetId: true,
      placerId: true,
      ownerId: true,
      status: true,
      amount: true,
      data: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  return rows
    .filter((row) => isStickerPlacementData(row.data))
    .map((row) => {
      const data = row.data as StickerPlacementData;
      const isParty = !!viewerId && (viewerId === row.ownerId || viewerId === row.placerId);

      return {
        id: row.id,
        imageId: row.targetId,
        placerId: row.placerId,
        ownerId: row.ownerId,
        status: row.status as PlacementStatus,
        amount: row.amount,
        placedAt: row.createdAt,
        // The note's text is deliberately NOT in the listing, which runs for
        // every image on a feed page — only whether there is one, so an overlay
        // can mark the sticker without the page carrying everyone's comments.
        // The text comes with the hover, from `getStickerPlacementDetail`.
        data: { ...data, comment: undefined, commentHidden: undefined },
        isPending: row.status === 'pending',
        hasComment: !!visibleStickerComment(data, isParty),
      };
    });
}

/** Approved placements per image, for the reaction-bar count. */
export async function getStickerPlacementCounts(imageIds: number[]) {
  if (!imageIds.length) return {} as Record<number, number>;

  const rows = await dbRead.placement.groupBy({
    by: ['targetId'],
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: { in: imageIds },
      status: 'approved',
    },
    _count: { _all: true },
  });

  return Object.fromEntries(rows.map((row) => [row.targetId, row._count._all]));
}

/**
 * Whether the money behind a placement moved, derived from the ledger.
 *
 * `Placement.status` is not consulted, and that is the point: it says the
 * placement was processed, not that anyone was paid. A leg that exhausted its
 * retries leaves a placement reading `approved` with Buzz still in escrow, and a
 * support thread where someone insists a creator was paid is exactly how that
 * surfaces if this reads the column.
 */
export async function getPlacementSettlementStates(
  placementIds: number[],
  viewerId?: number
): Promise<Record<number, PlacementSettlementState>> {
  if (!placementIds.length) return {};

  // Scoped to placements the viewer is actually party to. Without this any
  // signed-in user could enumerate whether an arbitrary placement had paid out
  // — the only read here that returns placement-derived state, so the only one
  // where an unscoped id list means anything.
  const visible = viewerId
    ? await dbRead.placement.findMany({
        where: {
          id: { in: placementIds },
          surface: SURFACE,
          OR: [{ placerId: viewerId }, { ownerId: viewerId }],
        },
        select: { id: true },
      })
    : [];
  const ids = visible.map((row) => row.id);
  if (!ids.length) return {};

  const legs = await dbRead.placementTransaction.findMany({
    where: {
      placementId: { in: ids },
      kind: { notIn: ['holdFee', 'holdPrincipal'] },
      amount: { gt: 0 },
    },
    select: { placementId: true, transactionId: true, attempts: true },
  });

  const states: Record<number, PlacementSettlementState> = Object.fromEntries(
    // No payout legs means nothing was owed — a placement still pending, or one
    // whose escrow never landed. Neither is money in flight.
    ids.map((id) => [id, 'settled' as PlacementSettlementState])
  );

  for (const leg of legs) {
    if (leg.transactionId) continue;
    states[leg.placementId] =
      leg.attempts >= MAX_LEG_ATTEMPTS
        ? 'stalled'
        : states[leg.placementId] === 'stalled'
        ? 'stalled'
        : 'pending';
  }

  return states;
}

// ---------------------------------------------------------------------------
// Owner actions
// ---------------------------------------------------------------------------

type OwnerAction = 'approve' | 'decline' | 'remove';

/**
 * The owner acting on a placement on their own content.
 *
 * `approve` and `decline` settle a pending placement. `remove` is a different
 * operation on a different state — a live placement whose money is already
 * paid — and goes through `removeApprovedSticker`, which explains why.
 */
export async function actOnStickerPlacement({
  placementId,
  action,
  userId,
  isModerator = false,
  hideComment,
}: {
  placementId: number;
  action: OwnerAction;
  userId: number;
  isModerator?: boolean;
  /**
   * Partial approval: take the sticker, refuse the note (Justin's call in the
   * 2026-08-12 review). Carried on the approve rather than left to a second
   * call, so an owner who refuses a note never has a moment where it is live.
   *
   * **`undefined` means "don't touch it", and that is load-bearing.** An owner
   * can already have hidden the note from the hover card while the placement
   * sat pending; defaulting this to `false` would make the ordinary Approve
   * button publish a note they had explicitly refused. Where the two readings
   * disagree, the safe one is the note staying hidden — it is someone else's
   * text on the owner's image, and the owner can put it back in one click.
   */
  hideComment?: boolean;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: {
      id: true,
      ownerId: true,
      placerId: true,
      targetId: true,
      amount: true,
      status: true,
      surface: true,
      data: true,
      createdAt: true,
      resolvedAt: true,
    },
  });

  if (!placement || placement.surface !== SURFACE)
    throw throwBadRequestError('placement: that placement no longer exists');
  if (placement.ownerId !== userId && !isModerator)
    throw throwAuthorizationError('placement: that placement is not on your content');

  if (action === 'remove' && placement.status !== 'approved')
    throw throwBadRequestError('placement: only a live placement can be removed');
  if (action !== 'remove' && placement.status !== 'pending')
    throw throwBadRequestError('placement: that placement has already been actioned');

  if (action === 'remove') return removeApprovedSticker({ placement, userId, isModerator });

  // Before the settle, so a refused note is never live for the window between
  // the two writes.
  if (action === 'approve' && hideComment !== undefined)
    await hideStickerComment(placement, hideComment);

  const { settled } = await settlePlacement({
    placementId,
    action: action === 'approve' ? 'approve' : 'decline',
    actorId: userId,
  });

  // Gated on the settle claiming the transition rather than on the action asked
  // for: two owners' tabs both pressing approve would otherwise count the same
  // payment on the image twice.
  if (action === 'approve' && settled)
    await recordPlacementTip({
      surface: SURFACE,
      imageId: placement.targetId,
      amount: placement.amount,
      placerId: placement.placerId,
    });

  return { settled };
}

type ActionablePlacement = {
  id: number;
  ownerId: number;
  status: string;
  data: unknown;
  createdAt: Date;
  resolvedAt: Date | null;
};

/**
 * The owner taking a live sticker off, once it has been up for its week.
 *
 * **Not `settlePlacement`, which cannot do this.** That claims its transition
 * with `WHERE status = 'pending'`, so an approved row matches nothing: the
 * removal reported success, moved no money and left the sticker exactly where it
 * was. The direct write is the same one `removePlacementByModerator` and the
 * remix gallery already use for a live row, and reusing their shape is what
 * stops a third meaning of "removed" existing.
 *
 * No money moves, which is the whole reason for the lock. Approval already paid
 * the owner, and a removal that refunded would let them bank the Buzz and wipe
 * the sticker before anyone saw it — indistinguishable from an honest removal,
 * and it costs the placer everything they paid. So the sticker stays up for a
 * week and then comes off for free, rather than coming off at once for a refund
 * the owner controls the timing of.
 */
async function removeApprovedSticker({
  placement,
  userId,
  isModerator,
}: {
  placement: ActionablePlacement;
  userId: number;
  isModerator: boolean;
}) {
  // A moderator acting on someone else's content is a takedown, not an owner
  // decision. An owner who also happens to be a moderator is still the owner —
  // the exemption follows the role being exercised, not the account.
  const isModeratorTakedown = isModerator && placement.ownerId !== userId;

  if (!isModeratorTakedown) {
    // Falls back to `createdAt` rather than skipping the check when `resolvedAt`
    // is absent. Gating on the column being set fails OPEN: a hand-seeded row,
    // or anything predating the approval path writing it, could be removed
    // immediately — the exact case the lock exists to prevent. `createdAt` is
    // never null, so there is always a time to measure from.
    const removableAt = stickerRemovableAt(placement.resolvedAt ?? placement.createdAt);
    if (removableAt > new Date())
      throw throwBadRequestError(
        `placement: this sticker can be removed from ${removableAt.toISOString()}. Someone paid to place it, so it stays up for a week after you accept it.`
      );
  }

  const { count } = await dbWrite.placement.updateMany({
    where: { id: placement.id, status: 'approved' },
    data: {
      status: 'removed',
      removedBy: isModeratorTakedown ? 'moderator' : 'owner',
      // Not `resolvedAt`/`resolvedById`: those record who approved it, and
      // overwriting them here would destroy the approval trail.
      takenDownAt: new Date(),
      takenDownById: userId,
    },
  });

  return { settled: count > 0 };
}

/**
 * Writes the note's hidden flag, preserving the rest of the payload.
 *
 * Read-modify-write rather than a JSON path update because `data` is the
 * surface's whole payload — position, scale, rotation, the cosmetic id — and a
 * client-supplied replacement would let an owner move someone's sticker while
 * refusing their note.
 */
async function hideStickerComment(placement: { id: number; data: unknown }, hidden: boolean) {
  if (!isStickerPlacementData(placement.data)) return;
  const data = placement.data as StickerPlacementData;
  // Nothing to hide and nothing to say about it. Writing the flag anyway would
  // put `commentHidden` on placements that never carried a note, which reads as
  // a refusal that never happened.
  if (!data.comment) return;

  await dbWrite.placement.update({
    where: { id: placement.id },
    data: { data: { ...data, commentHidden: hidden } },
  });
}

/**
 * The owner changing their mind about a note after the fact, either way.
 *
 * Unlocked, unlike removing the sticker: the week protects what the placer paid
 * for, which is the placement. The note came with it and is the owner's to
 * refuse at any time — and being able to put one back is what makes hiding a
 * safe first move on something ambiguous.
 */
export async function setStickerCommentHidden({
  placementId,
  hidden,
  userId,
  isModerator = false,
}: {
  placementId: number;
  hidden: boolean;
  userId: number;
  isModerator?: boolean;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { id: true, ownerId: true, surface: true, data: true },
  });

  if (!placement || placement.surface !== SURFACE)
    throw throwBadRequestError('placement: that placement no longer exists');
  if (placement.ownerId !== userId && !isModerator)
    throw throwAuthorizationError('placement: that placement is not on your content');

  await hideStickerComment(placement, hidden);

  return { hidden };
}

/**
 * The owner's review queue: everything pending across all of their content.
 *
 * Carries the image and the placer with it, because the queue's whole job is
 * deciding without leaving — a list of ids would send someone to eleven pages to
 * answer eleven placements.
 */
export async function getPendingStickerPlacements({
  ownerId,
  limit = 50,
}: {
  ownerId: number;
  limit?: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: { surface: SURFACE, ownerId, status: 'pending' },
    select: {
      id: true,
      targetId: true,
      placerId: true,
      amount: true,
      data: true,
      createdAt: true,
      expiresAt: true,
      placer: { select: { id: true, username: true, image: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  const images = await dbRead.image.findMany({
    where: { id: { in: rows.map((row) => row.targetId) } },
    select: { id: true, url: true, name: true, width: true, height: true, type: true },
  });
  const byId = new Map(images.map((image) => [image.id, image]));

  return rows
    .filter((row) => isStickerPlacementData(row.data))
    .map((row) => ({
      ...row,
      data: row.data as StickerPlacementData,
      image: byId.get(row.targetId) ?? null,
    }));
}

/**
 * Acting on several at once.
 *
 * Loops the same single-placement path rather than growing a bulk one that talks
 * to the ledger itself. A second route to a state that already has rules is
 * where every defect in this feature has come from, and "it is the same thing
 * but faster" is exactly how the two drift.
 *
 * Failures are collected rather than thrown: one placement whose payout leg is
 * having a bad day must not silently drop the other nine the owner just
 * actioned.
 */
export async function actOnStickerPlacements({
  placementIds,
  action,
  userId,
  isModerator = false,
  hideComment,
}: {
  placementIds: number[];
  action: OwnerAction;
  userId: number;
  isModerator?: boolean;
  /** `undefined` leaves each note as it is — see `actOnStickerPlacement`. */
  hideComment?: boolean;
}) {
  const failed: number[] = [];
  let settled = 0;

  for (const placementId of placementIds) {
    try {
      const result = await actOnStickerPlacement({
        placementId,
        action,
        userId,
        isModerator,
        hideComment,
      });
      if (result.settled) settled++;
    } catch (error) {
      failed.push(placementId);
      logToAxiom({
        name: 'sticker-placement',
        type: 'error',
        message: 'bulk action could not settle a placement',
        placementId,
        action,
        error: (error as Error).message,
      }).catch(() => null);
    }
  }

  return { considered: placementIds.length, settled, failed };
}
