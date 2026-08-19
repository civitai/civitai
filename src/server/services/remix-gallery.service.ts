import { Prisma } from '@prisma/client';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ImageSort, NsfwLevel } from '~/server/common/enums';
import type { SessionUser } from '~/types/session';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { remixAcceptReward } from '~/server/rewards/active/remixAccept.reward';
import { getAllImages } from '~/server/services/image.service';
import {
  createFreePlacement,
  getFreePlacementAllowance,
  hasUsedFreePlacementOn,
} from '~/server/services/free-placement.service';
import { holdPlacementEscrow, settlePlacement } from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { imageReviewedSql } from '~/server/common/image-visibility';
import type { QueueImage as SharedQueueImage } from '~/server/utils/queue-image';
import { toQueueImage } from '~/server/utils/queue-image';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';
import { onlySelectableLevels } from '~/shared/constants/browsingLevel.constants';
import {
  declineFeeAmount,
  encodePlacementQueueCursor,
  parsePlacementQueueCursor,
  PLACEMENT_QUEUE_PAGE_SIZE,
  PLACEMENT_SURFACES,
  splitPlacementPayment,
} from '~/shared/utils/placement';
import type { RemixGalleryPlacementData } from '~/shared/utils/remix-gallery';
import {
  isRemixGalleryPlacementData,
  REMIX_GALLERY_MAX_PENDING_PER_OWNER,
  REMIX_GALLERY_MAX_PINNED,
  REMIX_GALLERY_MINOR_HOST_MAX_LEVEL,
  REMIX_GALLERY_PAGE_SIZE,
  REMIX_GALLERY_QUEUE_LIMIT,
  remixGalleryBlockedByMinorHost,
  remixGalleryContentRule,
  remixGalleryLevelAllowed,
  remixGalleryMaxSubmissionLevel,
  remixGalleryRemovableAt,
  remixGalleryShuffleSeed,
} from '~/shared/utils/remix-gallery';

const SURFACE = 'remixGallery' as const;
const TARGET_TYPE = 'image' as const;

type SubmissionImage = {
  id: number;
  userId: number;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  tosViolation: boolean;
  ingestion: string;
  needsReview: string | null;
  publishedAt: Date | null;
  remixOfId: number | null;
  sourceImageIds: number[] | null;
};

/**
 * The ids the server verified this image was generated from.
 *
 * One definition, used by the mutation that decides and by the listing that
 * offers — because "is this a remix of that" has to mean the same thing in both
 * or the picker offers what the claim refuses.
 *
 * ⚠️ Not interchangeable with a bare `@>` containment test on the raw JSON, which
 * is what a second copy naturally becomes. `'7'::jsonb @> '7'::jsonb` is true
 * (scalar containment is equality), so a non-array value would read as a match
 * where this yields `[]`; an array of strings goes the other way, matching here
 * after the cast and not there. They agree today only because
 * `sanitizeProvenance` happens to write an integer array.
 *
 * Parameterised by alias rather than written twice, for the reason `hostIsMinor`
 * is: a hand-written duplicate is exactly the shape that drifts silently.
 */
const sourceImageIdsSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`ARRAY(
    SELECT (value #>> '{}')::int
    FROM jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(${t}.meta -> 'extra' -> 'sourceImageIds') = 'array'
        THEN ${t}.meta -> 'extra' -> 'sourceImageIds'
        ELSE '[]'::jsonb
      END
    )
  )`;
};

/**
 * The submitted image, from the primary, with everything the refusals need.
 *
 * `dbWrite` rather than a replica for the same reason `assertCanPlace` uses it:
 * these decide a mutation, and a rating raised or a takedown committed seconds
 * ago must refuse rather than be filtered out one render later.
 */
async function loadSubmissionImage(imageId: number): Promise<SubmissionImage> {
  const [row] = await dbWrite.$queryRaw<SubmissionImage[]>`
    SELECT i.id, i."userId", i."nsfwLevel", i.minor, i.poi, i."tosViolation",
           i.ingestion::text AS ingestion, i."needsReview",
           p."publishedAt",
           (i.meta -> 'extra' ->> 'remixOfId')::int AS "remixOfId",
           ${sourceImageIdsSql()} AS "sourceImageIds"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
  `;

  if (!row) throw throwBadRequestError('remix gallery: that image no longer exists');
  return row;
}

/**
 * Names a ceiling rather than the host's flag. The flag is a moderation state of
 * someone else's image and the submitter has no business reading it off an error.
 */
const MINOR_HOST_REFUSAL =
  'remix gallery: this image only accepts submissions rated PG-13 or below';

/**
 * The host image's rating and minor flag, from the primary for the same reason
 * `loadSubmissionImage` is.
 *
 * The flag is loaded here rather than at the call sites so no submission path
 * can decide a rating without it — `remixGalleryLevelAllowed` requires it.
 */
async function loadHostImage(hostImageId: number) {
  const [row] = await dbWrite.$queryRaw<{ nsfwLevel: number; minor: boolean; showable: boolean }[]>`
    SELECT i."nsfwLevel", ${hostIsMinor()} AS minor, ${hostIsShowable()} AS showable
    FROM "Image" i WHERE i.id = ${hostImageId}
  `;

  if (!row) throw throwBadRequestError('remix gallery: that image no longer exists');
  return row;
}

export type CreateRemixGallerySubmission = {
  placerId: number;
  /** The image whose gallery is being submitted to. */
  hostImageId: number;
  /** The image being submitted into it. */
  imageId: number;
  /** What the submitter was shown. Refused if the owner has moved it since. */
  expectedPrice?: number;
  /**
   * Spend the placer's daily free placement instead of Buzz. Allowed only for a
   * remix this server itself resolved as derived from the host image.
   */
  free?: boolean;
  /**
   * The domain's currency, decided at the router from the request's own feature
   * flags rather than anything the client sends — a client-supplied currency
   * would let a request on one domain spend the other's Buzz.
   */
  spendType: BuzzSpendType;
};

/**
 * Why an unverified remix cannot be submitted free.
 *
 * Names the alternative rather than only the refusal: paying is what buys a slot
 * in someone's review queue when the server cannot tell that the submission came
 * from their image, and a bare "not eligible" reads as a bug on a remix the
 * submitter knows they made.
 *
 * It does not say the submission "is not a remix" — an off-site remix is a real
 * remix that carries no signal, and calling it otherwise is both wrong and an
 * accusation.
 */
const FREE_NEEDS_VERIFIED_REFUSAL =
  'remix gallery: free submissions are for remixes made from this image on-site, which is something we can check. Submit this one with Buzz instead.';

/**
 * Submits an image into someone's remix gallery, charging the owner's price.
 *
 * Ordering matches `createStickerPlacement` and for the same reason: the row has
 * to exist before the escrow can reference it, so anything that throws after the
 * row exists expires it rather than deleting it — expiry refunds both holds
 * through real refunds of real holds, and `holdPlacementEscrow` has already
 * stamped a deadline, so the sweep reaches the row even if the compensating
 * settle also fails.
 *
 * Nothing here consumes an inventory item; unlike a sticker, the thing being
 * placed is content the submitter already owns. That is also why the free path
 * below has no unwind: there is no second write to fail after the row exists.
 */
export async function createRemixGallerySubmission({
  placerId,
  hostImageId,
  imageId,
  expectedPrice,
  free = false,
  spendType,
}: CreateRemixGallerySubmission) {
  if (hostImageId === imageId)
    throw throwBadRequestError('remix gallery: an image cannot be submitted to its own gallery');

  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: hostImageId,
  });

  if (space.mode === 'off')
    throw throwBadRequestError('remix gallery: this creator is not accepting submissions here');
  // `auto` is not offered for this surface and the space service refuses to
  // store it, but a row written before that rule existed would still read back
  // here. Refusing on the mutation is the guard; the settings picker is not.
  if (space.mode !== 'review')
    throw throwBadRequestError('remix gallery: submissions to this gallery need review');

  if (space.ownerId === placerId)
    throw throwBadRequestError('remix gallery: you cannot submit to your own gallery');

  const submission = await loadSubmissionImage(imageId);
  if (submission.userId !== placerId)
    throw throwAuthorizationError('remix gallery: you can only submit your own images');
  if (!submission.publishedAt)
    throw throwBadRequestError('remix gallery: publish the image before submitting it');
  if (submission.ingestion !== 'Scanned' || submission.needsReview)
    throw throwBadRequestError('remix gallery: that image is still being reviewed');

  // Not creator preferences, so they are refused under either content rule.
  if (submission.tosViolation || submission.minor || submission.poi)
    throw throwBadRequestError('remix gallery: that image cannot be submitted');

  const host = await loadHostImage(hostImageId);
  if (!host.showable)
    throw throwBadRequestError('remix gallery: this image cannot show a gallery right now');

  const rule = remixGalleryContentRule(space.settings);
  if (
    !remixGalleryLevelAllowed({
      rule,
      submissionLevel: submission.nsfwLevel,
      hostLevel: host.nsfwLevel,
      hostMinor: host.minor,
    })
  )
    throw throwBadRequestError(
      remixGalleryBlockedByMinorHost({
        submissionLevel: submission.nsfwLevel,
        hostMinor: host.minor,
      })
        ? MINOR_HOST_REFUSAL
        : rule === 'any'
        ? 'remix gallery: that image has no rating yet'
        : "remix gallery: this creator only accepts submissions rated at or below their image's rating"
    );

  // The server's own answer, from ids `sanitizeProvenance` wrote — a submitter
  // cannot assert this by editing their image's meta. It is what the free path
  // is gated on, so where it comes from decides whether that gate is real.
  const derivedFromHost = submission.sourceImageIds?.includes(hostImageId) ?? false;

  // Refused here, on the mutation, and deliberately not only by hiding the free
  // option: a listing that filters is not a mutation that refuses, and this one
  // decides whether someone gets into a creator's review queue without paying.
  if (free && !derivedFromHost) throw throwBadRequestError(FREE_NEEDS_VERIFIED_REFUSAL);

  const data = {
    imageId,
    remixOfId: submission.remixOfId,
    // Present only when the server itself resolved this host image as an input
    // to the generation. Left off rather than set false: "made elsewhere" and
    // "no signal" are the same state, and the owner-review UI must keep saying
    // nothing about either.
    ...(derivedFromHost ? { derivedFromHost: true } : {}),
  } satisfies RemixGalleryPlacementData;

  // Before the branch, so a free submission cannot occupy a second slot of the
  // same gallery with the same picture — `createFreePlacement` bounds free rows
  // per placer and per target, which is a different question from this one.
  await assertNotAlreadySubmitted({ hostImageId, imageId });

  // Every remaining refusal — mode, self-placement, `assertCanPlace`, the
  // per-owner pending cap — is made by `createFreePlacement` under its lock, in
  // the same transaction as the insert. Repeating them here would be a second
  // creation route with the checks bolted on the outside.
  //
  // No settle afterwards, and that is checked rather than assumed: `auto` is
  // refused for this surface where a space is stored (`placementSpaceSchema`),
  // where a submission is made (above), and by `createFreePlacement` itself
  // against `allowedModes`. So a free submission here is always pending and
  // always the owner's to answer.
  if (free)
    return createFreePlacement({
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      placerId,
      data,
    });

  // Every rule from here down is the paid path's, which is why none of them is
  // reached above. The floor in particular exists because the price is this
  // surface's only spam gate — nothing verifies that a *paid* submission is
  // really a remix — and a free one is gated on the server having verified
  // exactly that, plus the creator's slots and the placer's daily allowance.
  // Refusing a free submission because a legacy row is priced at 40 would refuse
  // it for a reason that does not apply to it.
  if (space.price == null)
    throw throwBadRequestError('remix gallery: this creator has not set a price yet');

  // `setPlacementSpace` refuses to write a price below the floor, but it lets an
  // existing lower one be carried, so a row predating the rule still reads back
  // here. Refused rather than rounded up: charging more than the number the
  // submitter was shown is the thing `expectedPrice` exists to prevent.
  if (space.price < PLACEMENT_SURFACES[SURFACE].serverMinPrice)
    throw throwBadRequestError('remix gallery: this gallery is not priced for submissions');

  // Refused rather than charged. The client can only check affordability against
  // the number it rendered, so charging a price the submitter never saw is a
  // spend without consent — and an owner can move their price at any time.
  if (expectedPrice != null && expectedPrice !== space.price)
    throw throwBadRequestError(
      `remix gallery: the price changed to ${space.price} Buzz while you were deciding`
    );

  await assertCanPlace({ ownerId: space.ownerId, placerId });

  const pending = await dbWrite.placement.count({
    where: { surface: SURFACE, ownerId: space.ownerId, placerId, status: 'pending' },
  });
  if (pending >= REMIX_GALLERY_MAX_PENDING_PER_OWNER)
    throw throwBadRequestError(
      'remix gallery: you already have the maximum submissions waiting with this creator'
    );

  const placement = await dbWrite.placement.create({
    data: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      ownerId: space.ownerId,
      placerId,
      // No seller: nobody sold the submitted image, so the surface's seller
      // share is zero and the owner takes the remainder after the platform cut.
      sellerId: null,
      amount: space.price,
      status: 'pending',
      data,
    },
    select: { id: true },
  });

  try {
    await holdPlacementEscrow({
      placementId: placement.id,
      placerId,
      surface: SURFACE,
      amount: space.price,
      spendType,
    });
  } catch (error) {
    await settlePlacement({ placementId: placement.id, action: 'expire' }).catch((settleError) =>
      logToAxiom({
        name: 'remix-gallery',
        type: 'error',
        message: 'compensating settle failed; escrow may be held for a rejected submission',
        placementId: placement.id,
        error: settleError instanceof Error ? settleError.message : String(settleError),
      }).catch(() => undefined)
    );
    throw error;
  }

  return placement;
}

/**
 * One image may sit in one gallery once, pending or live.
 *
 * Without this a submitter can pay repeatedly to occupy several slots of the
 * same gallery with the same picture, which is the cheapest way to defeat the
 * rotation — and, on decline, the cheapest way to hand the owner repeated fees
 * for the same decision.
 */
async function assertNotAlreadySubmitted({
  hostImageId,
  imageId,
}: {
  hostImageId: number;
  imageId: number;
}) {
  const existing = await dbWrite.placement.findFirst({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      status: { in: ['pending', 'approved'] },
      data: { path: ['imageId'], equals: imageId },
    },
    select: { id: true },
  });

  if (existing) throw throwBadRequestError('remix gallery: that image is already in this gallery');
}

type OwnerAction = 'approve' | 'decline' | 'remove';

export async function actOnRemixGallerySubmission({
  placementId,
  action,
  userId,
  isModerator = false,
  asModerator = false,
}: {
  placementId: number;
  action: OwnerAction;
  userId: number;
  isModerator?: boolean;
  asModerator?: boolean;
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
      free: true,
      data: true,
      resolvedAt: true,
      createdAt: true,
    },
  });

  if (!placement || placement.surface !== SURFACE)
    throw throwBadRequestError('remix gallery: that submission no longer exists');
  if (placement.ownerId !== userId && !isModerator)
    throw throwAuthorizationError('remix gallery: that submission is not on your content');

  if (action === 'remove' && placement.status !== 'approved')
    throw throwBadRequestError('remix gallery: only a live entry can be removed');
  if (action !== 'remove' && placement.status !== 'pending')
    throw throwBadRequestError('remix gallery: that submission has already been actioned');

  // The rating can move between submission and approval, and approval is the
  // moment it becomes public. Re-checked rather than trusted.
  if (action === 'approve') {
    // Refused rather than skipped. A row whose payload cannot be read is the
    // one case where waving the safety re-check through is least defensible.
    if (!isRemixGalleryPlacementData(placement.data))
      throw throwBadRequestError(
        'remix gallery: that submission is unreadable and cannot be approved'
      );

    await assertStillAcceptable({
      placementId: placement.id,
      imageId: placement.data.imageId,
    });
  }

  // A live entry cannot go through `settlePlacement`: that claims its
  // transition with `WHERE status = 'pending'`, so an approved row matches
  // nothing and the owner watches the entry stay exactly where it is. Taken
  // down by the same direct write the moderator path uses, and for the same
  // reason — see `removePlacementByModerator`.
  //
  // No money moves. Approval already paid the owner out of escrow, so there is
  // nothing left to refund; clawing it back after the fact would punish an
  // owner for taking down content they were entitled to remove.
  if (action === 'remove') {
    // Refused on the mutation, not merely by disabling the button. Approval
    // settles the money immediately, so without this an owner could accept a
    // submission, keep the Buzz and remove the entry before anyone saw it —
    // which is indistinguishable from an honest removal and costs the submitter
    // everything they paid.
    //
    // A moderator is exempt: a removal by a moderator is a moderation record
    // rather than an owner decision, and the abusive cases are the ones that
    // must not wait. On their own gallery they are exempt only when they asked
    // to be — otherwise a moderator would silently never be held to the wait
    // their own submitters were promised.
    //
    // `isModerator` is the permission and `asModerator` only picks between two
    // things this caller may already do, so the claim is read INSIDE the role
    // check rather than beside it. On someone else's gallery there is no
    // creator role to go back to, so the claim is not asked for.
    const isModeratorTakedown = isModerator && (placement.ownerId !== userId || asModerator);
    if (!isModeratorTakedown) {
      // Falls back to `createdAt` rather than skipping when `resolvedAt` is
      // absent. Gating the check on the column being set made this fail OPEN:
      // any approved row without one — a hand-seeded row, anything predating
      // the approval path writing it — could be removed immediately, which is
      // the exact case the lock exists to prevent. `createdAt` is never null,
      // so there is always a time to measure from.
      const removableAt = remixGalleryRemovableAt(placement.resolvedAt ?? placement.createdAt);
      if (removableAt > new Date())
        throw throwBadRequestError(
          `remix gallery: this entry can be removed from ${removableAt.toISOString()}. ${
            // The week itself is unchanged for a free entry — Justin's call, so
            // the two paths cannot differ on how long an approval binds. Only the
            // reason differs: nothing was paid, so the copy cannot say it was.
            // Note what this costs, because it is intended rather than an
            // oversight: an approved free entry holds one of the creator's free
            // slots for the whole week too.
            placement.free
              ? 'Accepting a remix is a week-long commitment either way, so it stays up for a week after you approve it.'
              : 'Someone paid to be featured here, so it stays up for a week after you approve it.'
          }`
        );
    }

    const { count } = await dbWrite.placement.updateMany({
      where: { id: placementId, status: 'approved' },
      data: {
        status: 'removed',
        // A moderator acting as one is a moderation record, not an owner
        // decision, and the two refund differently everywhere else in this
        // system. Recording it as `owner` would misattribute it — including on
        // their own gallery, where the moderator exemption above is what let
        // the removal through at all.
        removedBy: isModeratorTakedown ? 'moderator' : 'owner',
        // Not `resolvedAt`/`resolvedById`: those record who approved it, and
        // overwriting them here would destroy the approval trail.
        takenDownAt: new Date(),
        takenDownById: userId,
      },
    });

    if (!count)
      throw throwBadRequestError('remix gallery: that entry was already removed elsewhere');

    return { settled: true, removed: true };
  }

  // A decline charges the submitter the non-refundable share, and that share
  // prices the owner's attention: a spammer costs them a review. When the host
  // cannot show a gallery the owner was never offered a choice — approve is
  // refused above — so there is no judgement to charge for, and the submitter is
  // refunded in full — but recorded as a decline, because that is what happened.
  // Settling it as an expiry would have written the same money and then told
  // every later reader that the hold timed out with nobody acting.
  //
  // Without this, the fair outcome for the submitter was the one where the owner
  // ignored their queue: doing nothing expires the hold and returns everything,
  // while tidying up took 30% for a refusal caused entirely by the host's state.
  const declineRefundsInFull =
    action === 'decline' && !(await loadHostImage(placement.targetId)).showable;

  const result = await settlePlacement({
    placementId,
    action:
      action === 'approve' ? 'approve' : declineRefundsInFull ? 'declineUnshowableHost' : 'decline',
    actorId: userId,
  });

  // `settlePlacement` claims its transition with `WHERE status = 'pending'`, so
  // a race against the expiry sweep or a block moves no money and returns
  // `settled: false`. Reported rather than swallowed: a moderator action that
  // appeared to work and did not is what this cost us on chunk D.
  if (!result.settled)
    throw throwBadRequestError('remix gallery: that submission was already resolved elsewhere');

  // Fired only from behind that `settled` check, which is the whole double-pay
  // guard: it is true for exactly one call in a placement's life. Re-presenting a
  // placement this already paid for would spend a slot of the owner's daily cap
  // and move no Buzz, silently — see `remixAcceptReward`.
  //
  // Swallowed rather than rethrown, unlike the reward's own inline fail-soft: the
  // settle above already committed and paid out, so a throw here would report a
  // failure for an approval that happened and cannot be retried.
  if (action === 'approve')
    await remixAcceptReward
      .apply({
        placementId: placement.id,
        ownerId: placement.ownerId,
        placerId: placement.placerId,
      })
      .catch((error) =>
        logToAxiom({
          name: 'remix-gallery',
          type: 'error',
          message: 'accept reward failed; the submission is approved and the owner unpaid',
          placementId: placement.id,
          error: error instanceof Error ? error.message : String(error),
        }).catch(() => undefined)
      );

  return result;
}

/**
 * Decline every pending submission rated above what this gallery accepts.
 *
 * The set is resolved here from (hostImageId, the owner's own rule) rather than
 * taken as a list of ids: an id list on a money path is forgeable, and a caller
 * who could name the rows could decline ones that are perfectly in band.
 *
 * Loops the single-placement path rather than growing a bulk settlement, for the
 * reason `actOnStickerPlacements` gives — a second route to a state that already
 * has rules is where this feature's defects have come from. Failures are counted,
 * not thrown: one row whose payout leg is having a bad day must not strand the
 * other nine, and `settlePlacement` claims with `WHERE status = 'pending'`, so a
 * partial run is safe to repeat.
 */
export async function declineOutOfBandRemixGallerySubmissions({
  hostImageId,
  userId,
}: {
  hostImageId: number;
  userId: number;
}) {
  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: hostImageId,
  });
  // Not a permission check with a friendlier error — `actOnRemixGallerySubmission`
  // authorises every row it touches. This only avoids doing the work to build a
  // set that every settle would then refuse.
  if (space.ownerId !== userId)
    throw throwAuthorizationError('remix gallery: that gallery is not yours');

  const host = await loadHostImage(hostImageId);
  const band = remixGalleryMaxSubmissionLevel({
    rule: remixGalleryContentRule(space.settings),
    hostLevel: host.nsfwLevel,
    // Same fail-closed as the read path: an unresolvable host must not widen the
    // band, which here would mean declining fewer rows rather than more.
    hostMinor: host.minor,
  });

  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      ownerId: userId,
      status: 'pending',
    },
    select: { id: true, data: true },
  });

  const entries = rows.filter((row) => isRemixGalleryPlacementData(row.data));
  const imageIds = entries.map((row) => (row.data as RemixGalleryPlacementData).imageId);
  if (!imageIds.length) return { considered: 0, settled: 0 };

  // Read straight from `Image` rather than through the queue's listability
  // filter: a submission whose image was since unpublished no longer appears in
  // the queue but is still pending, still holding escrow, and still out of band.
  // Leaving those behind would make the button quietly disagree with its label.
  const levels = await dbRead.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, nsfwLevel: true },
  });
  const levelById = new Map(levels.map((image) => [image.id, image.nsfwLevel]));

  const outOfBand = entries.filter((row) => {
    const level = levelById.get((row.data as RemixGalleryPlacementData).imageId);
    // `band` is a ceiling compared with `<=`, not a bitmask — see
    // `remixGalleryLevelAllowed`, which is defined in terms of it.
    //
    // Strictly above, so an unrated row (level 0) is left alone rather than
    // swept up. `remixGalleryLevelAllowed` would call 0 inadmissible, which is
    // right for approval and wrong here: charging a decline fee for an image
    // that has no rating yet answers a question nobody asked. Its escrow is the
    // expiry sweep's to return in full.
    return !!level && level > band;
  });

  let settled = 0;
  for (const row of outOfBand) {
    try {
      await actOnRemixGallerySubmission({ placementId: row.id, action: 'decline', userId });
      settled++;
    } catch (error) {
      await logToAxiom({
        name: 'remix-gallery',
        type: 'error',
        message: 'decline-out-of-band: one row failed to settle',
        placementId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }).catch(() => undefined);
    }
  }

  return { considered: outOfBand.length, settled };
}

/**
 * Everything the submission had to satisfy to be sent, checked again at the
 * moment it becomes public.
 *
 * The rating is the reason this exists — a scanner can re-rate an image between
 * submission and approval, including down to 0 — so it is checked against the
 * host's ceiling under the owner's current rule, not just against the flags.
 * Checking the flags alone let an XXX entry onto a PG host under the very rule
 * that exists to prevent it.
 */
async function assertStillAcceptable({
  placementId,
  imageId,
}: {
  placementId: number;
  imageId: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { targetId: true },
  });
  if (!placement) throw throwBadRequestError('remix gallery: that submission no longer exists');

  const submission = await loadSubmissionImage(imageId);
  if (submission.tosViolation || submission.minor || submission.poi || submission.needsReview)
    throw throwBadRequestError('remix gallery: that image can no longer be shown');

  const space = await resolvePlacementSpaceFor({
    surface: SURFACE,
    targetType: TARGET_TYPE,
    targetId: placement.targetId,
  });

  const host = await loadHostImage(placement.targetId);
  // Refused rather than approved into a gallery that cannot render. The escrow
  // is released by expiry, which refunds in full, so waiting costs the submitter
  // nothing — approving costs them everything.
  if (!host.showable)
    throw throwBadRequestError('remix gallery: this image cannot show a gallery right now');

  if (
    !remixGalleryLevelAllowed({
      rule: remixGalleryContentRule(space.settings),
      submissionLevel: submission.nsfwLevel,
      hostLevel: host.nsfwLevel,
      hostMinor: host.minor,
    })
  )
    // Names both possibilities, because the rule is as likely to have moved as
    // the rating: an owner who tightens their content rule after submissions
    // arrive gets this on approval, and blaming the image would send them
    // looking at the wrong thing.
    throw throwBadRequestError(
      remixGalleryBlockedByMinorHost({
        submissionLevel: submission.nsfwLevel,
        hostMinor: host.minor,
      })
        ? MINOR_HOST_REFUSAL
        : "remix gallery: that image's rating no longer fits this gallery's content rule"
    );
}

/**
 * The submitter withdrawing before the owner has acted.
 *
 * Refunded in full and no decline fee: the fee is the price of the owner's
 * attention and a withdrawn submission never had any. Same money path as
 * expiry, which is why it reuses `expire` rather than growing a second one.
 */
export async function retractRemixGallerySubmission({
  placementId,
  placerId,
}: {
  placementId: number;
  placerId: number;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: { id: true, placerId: true, status: true, surface: true },
  });

  if (!placement || placement.surface !== SURFACE)
    throw throwBadRequestError('remix gallery: that submission no longer exists');
  if (placement.placerId !== placerId)
    throw throwAuthorizationError('remix gallery: that submission is not yours');
  if (placement.status !== 'pending')
    throw throwBadRequestError(
      'remix gallery: that submission has already been reviewed and cannot be withdrawn'
    );

  const result = await settlePlacement({ placementId, action: 'expire', actorId: placerId });
  if (!result.settled)
    throw throwBadRequestError('remix gallery: that submission was already resolved elsewhere');

  return result;
}

/**
 * Sets which entries are pinned, and their order among themselves.
 *
 * Written as a whole set rather than a per-entry toggle: the cap and the
 * ordering are properties of the set, and enforcing a cap one toggle at a time
 * means two concurrent pins can both see room for one more.
 */
export async function setRemixGalleryPins({
  hostImageId,
  ownerId,
  placementIds,
}: {
  hostImageId: number;
  ownerId: number;
  placementIds: number[];
}) {
  if (placementIds.length > REMIX_GALLERY_MAX_PINNED)
    throw throwBadRequestError(
      `remix gallery: you can pin up to ${REMIX_GALLERY_MAX_PINNED} entries`
    );
  if (new Set(placementIds).size !== placementIds.length)
    throw throwBadRequestError('remix gallery: an entry cannot be pinned twice');

  // Scoped to entries already pinned plus the ones being pinned now, rather
  // than every approved entry: a gallery can hold thousands, the cap is four,
  // and the modal commits on every drag. Reading the whole gallery to rewrite
  // four rows made a drag cost one UPDATE per entry.
  const entries = await dbWrite.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      // The authorization guard. `hostImageId` is caller-supplied, so without
      // this any signed-in user could pin and unpin entries in anyone's gallery.
      ownerId,
      status: 'approved',
      OR: [{ id: { in: placementIds } }, { data: { path: ['pinnedAt'], not: Prisma.DbNull } }],
    },
    select: { id: true, data: true },
  });

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const unknown = placementIds.filter((id) => !byId.has(id));
  if (unknown.length)
    throw throwBadRequestError('remix gallery: one of those entries is not in this gallery');

  const pinnedAt = new Date().toISOString();

  const writes = entries.flatMap((entry) => {
    const index = placementIds.indexOf(entry.id);
    const data = (
      isRemixGalleryPlacementData(entry.data) ? entry.data : {}
    ) as RemixGalleryPlacementData;

    const next = {
      ...data,
      pinnedAt: index === -1 ? null : data.pinnedAt ?? pinnedAt,
      position: index === -1 ? null : index,
    } satisfies RemixGalleryPlacementData;

    // A drag that reorders two pins should not rewrite the two it did not move.
    const unchanged =
      (data.pinnedAt ?? null) === next.pinnedAt && (data.position ?? null) === next.position;
    if (unchanged) return [];

    return [dbWrite.placement.update({ where: { id: entry.id }, data: { data: next } })];
  });

  if (writes.length) await dbWrite.$transaction(writes);

  return { pinned: placementIds.length };
}

/**
 * A gallery entry carries a whole feed-shaped image, not an id.
 *
 * The image-detail dialog browses a set it is handed and accepts only
 * `ImageGetInfinite[number]`, so "clicking an entry browses the gallery" cannot
 * be served by a thin projection — there is no lighter shape that works.
 *
 * `sortKey` is deliberately not on the entry. It exists to order and to page,
 * and it travels in the cursor; putting it on the item invites a client to sort
 * by it and quietly reimplement an ordering the server owns.
 */
export type RemixGalleryEntry = {
  placementId: number;
  placerId: number;
  pinned: boolean;
  /**
   * When the owner approved it. The removal lock is measured from here, and the
   * client needs it to say how long is left rather than guessing at the date.
   */
  resolvedAt: Date | null;
  image: AsyncReturnType<typeof getAllImages>['items'][number];
};

/**
 * The raw row, which is not the returned entry: Postgres has no boolean here
 * because the pinned flag is derived with a `CASE` so it can also be ordered by,
 * and `position` is only meaningful while sorting.
 */
type GalleryRow = {
  placementId: number;
  imageId: number;
  placerId: number;
  pinned: number;
  /** Coalesced in the query, so never null despite the column being nullable. */
  position: number;
  sortKey: number;
  resolvedAt: Date | null;
};

/**
 * Feed-shaped images for an already-decided page, keyed by id.
 *
 * Goes through `getAllImages` rather than projecting by hand: that function is
 * what defines `ImageGetInfinite`, and a second hand-rolled projection would
 * drift from it silently — the dialog would then receive something that type-
 * checks against a stale shape.
 *
 * **This does not decide which entries appear.** The ordering CTE has already
 * applied every visibility predicate and the keyset; this only fills in rows it
 * chose. `getAllImages` runs its own predicates too, and where the two disagree
 * the stricter answer wins by dropping the row — logged rather than swallowed,
 * because a persistent gap means the CTE is admitting something the feed would
 * not, which is a correctness bug in the CTE and not a display quirk.
 */
async function hydrateGalleryImages({
  imageIds,
  browsingLevel,
  user,
}: {
  imageIds: number[];
  browsingLevel: number;
  user?: SessionUser;
}) {
  if (!imageIds.length) return new Map<number, RemixGalleryEntry['image']>();

  const { items } = await getAllImages({
    ids: imageIds,
    // The page is already chosen, so this bounds the hydration rather than the
    // result — it must not be smaller than the page or rows go missing.
    limit: imageIds.length,
    browsingLevel,
    user,
    period: MetricTimeframe.AllTime,
    periodMode: 'published',
    sort: ImageSort.Newest,
    withMeta: false,
    include: ['cosmetics'],
  });

  const byId = new Map(items.map((image) => [image.id, image]));

  if (byId.size !== imageIds.length)
    logToAxiom({
      name: 'remix-gallery',
      type: 'warning',
      message: 'gallery page lost rows between the ordering query and hydration',
      requested: imageIds.length,
      hydrated: byId.size,
      missing: imageIds.filter((id) => !byId.has(id)),
    }).catch(() => undefined);

  return byId;
}

/**
 * One page of a gallery, pinned entries first and the rest in a seeded shuffle.
 *
 * The shuffle is the contest-collection scheme — a keyed hash permutation rather
 * than `random()` — because the detail view browses this set, and an order that
 * reshuffles between pages makes next/previous incoherent. The seed travels in
 * the cursor so a paging session stays on one permutation across an hour
 * boundary.
 *
 * The visibility predicates live **inside** the ordering CTE rather than outside
 * it. The collection implementation filters after ordering, which forces it to
 * sort the whole set on every page; filtering first lets the limit apply to rows
 * that will actually be returned.
 */
export async function getRemixGallery({
  hostImageId,
  browsingLevel,
  cursor,
  limit = REMIX_GALLERY_PAGE_SIZE,
  user,
}: {
  hostImageId: number;
  browsingLevel: number;
  cursor?: string | null;
  limit?: number;
  /** The viewer, so the hydration applies their blocks and hidden preferences. */
  user?: SessionUser;
}) {
  const parsed = parseGalleryCursor(cursor);
  const seed = parsed?.seed ?? remixGalleryShuffleSeed();
  const levels = onlySelectableLevels(browsingLevel);

  // Every column the ORDER BY sorts on has to appear here, in the same order and
  // the same direction, or the cursor cannot say where it stopped. `position`
  // was missing and pinned entries repeated across pages: the tie-break fell
  // through to `sortKey`, which does not agree with the order pinned rows are
  // actually shown in.
  const keyset = parsed
    ? Prisma.sql`AND (
        e.pinned < ${parsed.pinned}
        OR (e.pinned = ${parsed.pinned} AND e.position > ${parsed.position})
        OR (e.pinned = ${parsed.pinned} AND e.position = ${parsed.position} AND e."sortKey" < ${parsed.sortKey})
        OR (e.pinned = ${parsed.pinned} AND e.position = ${parsed.position} AND e."sortKey" = ${parsed.sortKey} AND e."placementId" < ${parsed.placementId})
      )`
    : Prisma.empty;

  const rows = await dbRead.$queryRaw<GalleryRow[]>`
    WITH e AS (
      SELECT
        pl.id AS "placementId",
        i.id AS "imageId",
        pl."placerId",
        pl."resolvedAt",
        CASE WHEN pl.data ->> 'pinnedAt' IS NOT NULL THEN 1 ELSE 0 END AS pinned,
        -- Coalesced rather than ordered NULLS LAST, because the keyset compares
        -- it and every comparison against NULL is NULL, which drops the row
        -- instead of paging past it.
        COALESCE((pl.data ->> 'position')::int, 2147483647) AS position,
        -- The ::text is load-bearing. Prisma binds this as a parameter, and
        -- concat() is variadic "any", so without a cast Postgres cannot infer
        -- the type and rejects the statement at parse time — every call throws.
        abs(mod(hashtext(concat(pl.id::text, ${seed.toString()}::text)), 1000000000)) AS "sortKey"
      FROM "Placement" pl
      JOIN "Image" i ON i.id = (pl.data ->> 'imageId')::int
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE pl.surface = ${SURFACE}
        AND pl."targetType" = ${TARGET_TYPE}
        AND pl."targetId" = ${hostImageId}
        AND pl.status = 'approved'
        AND p."publishedAt" IS NOT NULL
        AND p."publishedAt" < now()
        AND i.ingestion = 'Scanned'
        AND i."needsReview" IS NULL
        AND NOT i."tosViolation"
        AND NOT i.minor
        AND NOT i.poi
        AND (i."nsfwLevel" & ${levels}) != 0
        AND i."nsfwLevel" != 0${minorHostCeiling(hostImageId)}
    )
    SELECT * FROM e
    WHERE TRUE ${keyset}
    ORDER BY e.pinned DESC, e.position ASC, e."sortKey" DESC, e."placementId" DESC
    LIMIT ${limit + 1}
  `;

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];

  const images = await hydrateGalleryImages({
    imageIds: page.map((row) => row.imageId),
    browsingLevel,
    user,
  });

  return {
    items: page
      .map((row) => {
        const image = images.get(row.imageId);
        return image
          ? {
              placementId: row.placementId,
              placerId: row.placerId,
              pinned: row.pinned === 1,
              resolvedAt: row.resolvedAt,
              image,
            }
          : null;
      })
      .filter((entry): entry is RemixGalleryEntry => entry !== null),
    nextCursor:
      hasMore && last
        ? `${seed}:${last.pinned === 1 ? 1 : 0}:${last.position}:${last.sortKey}:${
            last.placementId
          }`
        : null,
  };
}

/**
 * What counts as a host depicting a minor. Three columns, because each catches a
 * population the others miss.
 *
 * `acceptableMinor` is the moderator checkbox "Realistic depiction of a minor",
 * and it is the load-bearing one. It is written by a function that touches no
 * other column, so it is independent of `minor` — and every other minor-related
 * gate in this codebase checks it, several without checking `minor` at all.
 *
 * `minor` alone is narrower than it looks: resolving a minor review without
 * `removeMinorFlag` writes `CASE WHEN "nsfwLevel" >= 4 THEN FALSE ELSE TRUE`, so
 * a set `minor` is nearly always a PG/PG-13 image already under this ceiling.
 * The R-and-above host the cap exists for lands in `acceptableMinor`.
 *
 * `needsReview = 'minor'` is the unresolved case, included because the
 * resolution can go either way and fail-closed is the posture everywhere else.
 *
 * Parameterised by alias rather than written twice. The second copy — one for
 * the `h` alias in the gallery read — was a hand-written duplicate, which is
 * exactly the shape that drifts silently and fails open.
 */
const hostIsMinor = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`((${t}.minor OR ${t}."acceptableMinor" OR ${t}."needsReview" = 'minor') IS TRUE)`;
};

/**
 * Whether the host can display a gallery at all.
 *
 * Every check on this surface asked what the *submission* was, and none asked
 * whether the host could show it. A blocked or unscanned host is hidden from
 * everyone but its owner, yet nothing required the submitter to be able to see
 * it — so Buzz went into escrow for a placement that could never render, and
 * the submitter's only ways out were withdrawing or being charged the decline
 * fee. Not a safety hole, since display is gated either way; it is money taken
 * for something structurally unshowable.
 *
 * Built on `imageReviewedSql` rather than on `ingestion = 'Scanned'`, which is
 * what this originally said. That is *stricter* than the rule it claims to
 * track, and stricter in the direction that costs a creator revenue: a stalled
 * scan that a moderator rated, or a routine `Rescan` of a published image, is
 * visible to every viewer through that helper's second arm and would have been
 * refused here. Same mistake as reading `minor` alone — a hand-rolled predicate
 * where the repo already has the canonical one.
 *
 * The trailing `IS TRUE` matches its sibling. Every input here is NOT NULL
 * today, so it changes nothing — but that is a property of four column
 * defaults rather than of this expression, and a NULL leaking through a future
 * `NOT` would drop rows silently instead of keeping them.
 */
const hostIsShowable = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`((
    ${t}."needsReview" IS NULL
    AND ${imageReviewedSql(alias)}
    AND NOT ${t}."tosViolation"
    AND ${t}."nsfwLevel" != ${NsfwLevel.Blocked}
  ) IS TRUE)`;
};

/**
 * The host's rating and flags from the replica, for display decisions.
 *
 * Deliberately not `loadHostImage`: that reads the primary because it decides a
 * mutation, and this runs on every image-detail view. The predicates are shared,
 * so the two cannot disagree about *what* a minor or showable host is — only,
 * under replica lag, about a flag set in the last moment. The mutation still
 * refuses, so the cost of that window is a picker offering an image that is then
 * declined.
 */
async function readHostImage(hostImageId: number) {
  const [row] = await dbRead.$queryRaw<{ nsfwLevel: number; minor: boolean; showable: boolean }[]>`
    SELECT i."nsfwLevel", ${hostIsMinor()} AS minor, ${hostIsShowable()} AS showable
    FROM "Image" i WHERE i.id = ${hostImageId}
  `;
  return row ?? null;
}

/**
 * The display-side half of the minor-host ceiling.
 *
 * The mutation refuses an over-rating submission, but a host can be flagged as
 * depicting a minor *after* entries were approved, and approval is irreversible
 * for a week. So the ceiling is applied on read too — an entry that becomes
 * inadmissible stops rendering rather than waiting on a takedown.
 */
const minorHostCeiling = (hostImageId: number) => Prisma.sql`
        AND (
          i."nsfwLevel" <= ${REMIX_GALLERY_MINOR_HOST_MAX_LEVEL}
          OR NOT EXISTS (
            SELECT 1 FROM "Image" h WHERE h.id = ${hostImageId} AND ${hostIsMinor('h')}
          )
        )`;

export function parseGalleryCursor(cursor?: string | null) {
  if (!cursor) return null;
  const parts = cursor.split(':');
  if (parts.length !== 5) return null;

  const [seed, pinned, position, sortKey, placementId] = parts.map(Number);
  // A malformed cursor becomes a fresh first page rather than a NaN
  // interpolated into the query, which would silently select a different but
  // stable permutation.
  if (![seed, pinned, position, sortKey, placementId].every(Number.isFinite)) return null;

  return { seed, pinned, position, sortKey, placementId };
}

/**
 * Whether a gallery should render at all.
 *
 * `off` means the owner is not accepting new submissions, not that what they
 * already accepted disappears — otherwise a creator could take the Buzz and
 * then hide everything they sold. So an off gallery with live entries still
 * renders, and only an off *and* empty one goes away.
 */
/**
 * Whether this gallery has anything the viewer may see.
 *
 * Its own query rather than `getRemixGallery({ limit: 1 })`: that path now
 * hydrates a whole feed-shaped image, and this runs on every image detail view
 * including the overwhelming majority that have no gallery at all.
 *
 * The predicates are the ordering query's, minus the ordering — they must stay
 * identical or an owner is shown a card for entries nobody else can see. The
 * shuffle plays no part in whether something exists.
 */
async function galleryHasEntries({
  hostImageId,
  browsingLevel,
}: {
  hostImageId: number;
  browsingLevel: number;
}) {
  const levels = onlySelectableLevels(browsingLevel);

  const [row] = await dbRead.$queryRaw<{ exists: boolean }[]>`
    SELECT EXISTS (
      SELECT 1
      FROM "Placement" pl
      JOIN "Image" i ON i.id = (pl.data ->> 'imageId')::int
      LEFT JOIN "Post" p ON p.id = i."postId"
      WHERE pl.surface = ${SURFACE}
        AND pl."targetType" = ${TARGET_TYPE}
        AND pl."targetId" = ${hostImageId}
        AND pl.status = 'approved'
        AND p."publishedAt" IS NOT NULL
        AND p."publishedAt" < now()
        AND i.ingestion = 'Scanned'
        AND i."needsReview" IS NULL
        AND NOT i."tosViolation"
        AND NOT i.minor
        AND NOT i.poi
        AND (i."nsfwLevel" & ${levels}) != 0
        AND i."nsfwLevel" != 0${minorHostCeiling(hostImageId)}
    ) AS "exists"
  `;

  return row?.exists ?? false;
}

/**
 * What the viewer has waiting on this gallery, so submitting is not a button
 * that appears to do nothing.
 *
 * Scoped to the viewer's own rows: how many submissions an owner is sitting on
 * is the owner's business, and `pendingCount` above is the owner-only number.
 * Rows whose image no longer resolves are kept — an unpublished or re-flagged
 * image is exactly when the submitter needs to see the row and withdraw it.
 */
async function getViewerPendingSubmissions({
  hostImageId,
  viewerId,
  domainLevels,
  viewerLevels,
}: {
  hostImageId: number;
  viewerId: number;
  /** Levels this domain may serve. Rows above it come back without their asset. */
  domainLevels: number;
  /** The viewer own band. Marked on each row, never filtered on. */
  viewerLevels: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
      placerId: viewerId,
      status: 'pending',
    },
    select: { id: true, amount: true, free: true, data: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'asc' },
    take: REMIX_GALLERY_MAX_PENDING_PER_OWNER,
  });

  const entries = rows.filter((row) => isRemixGalleryPlacementData(row.data));
  const imageIds = entries.map((row) => (row.data as RemixGalleryPlacementData).imageId);
  if (!imageIds.length) return [];

  const images = await dbRead.$queryRaw<GalleryThumbImage[]>`
    SELECT i.id, i.url, i.width, i.height, i.type, i.metadata, i."nsfwLevel"
    FROM "Image" i
    WHERE i.id IN (${Prisma.join(imageIds)})
  `;
  const byId = new Map(images.map((image) => [image.id, image]));

  return entries.map((row) => ({
    placementId: row.id,
    amount: row.amount,
    free: row.free,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    image: toQueueImage(
      byId.get((row.data as RemixGalleryPlacementData).imageId),
      domainLevels,
      viewerLevels
    ),
  }));
}

type GalleryThumbImage = {
  id: number;
  url: string;
  width: number | null;
  height: number | null;
  type: MediaType;
  metadata: MixedObject | null;
  nsfwLevel: number;
};

/**
 * Re-exported rather than redeclared. Both queues answer one question — may this
 * domain be sent this asset — and two copies of that answer is the drift the
 * shared listability fragment exists to prevent.
 */
export type QueueImage = SharedQueueImage<GalleryThumbImage>;

/**
 * Whether an image can be shown in a review queue, as one definition rather than
 * two copies of a WHERE clause. The badge and the list that badge counts must
 * agree, and they disagreed for as long as each carried its own.
 */
const queueImageIsListable = (imageId: Prisma.Sql) => Prisma.sql`
  EXISTS (
    SELECT 1
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
      AND p."publishedAt" IS NOT NULL
      AND i.ingestion = 'Scanned'
      AND NOT i."tosViolation"
      AND NOT i.minor
      AND NOT i.poi
  )`;

/**
 * Both images are tested: a submission the owner can see, on a host that still
 * renders. A host taken down after submissions arrived leaves rows nobody can
 * judge — the gallery they would appear in is gone — and those refund in full on
 * expiry rather than costing the submitter a decline fee.
 */
async function countListablePendingSubmissions({
  hostImageId,
  ownerId,
}: {
  hostImageId: number;
  ownerId: number;
}) {
  const [row] = await dbRead.$queryRaw<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM "Placement" pl
    WHERE pl.surface = ${SURFACE}
      AND pl."targetType" = ${TARGET_TYPE}
      AND pl."targetId" = ${hostImageId}
      AND pl."ownerId" = ${ownerId}
      AND pl.status = 'pending'
      AND ${queueImageIsListable(Prisma.sql`(pl.data ->> 'imageId')::int`)}
      AND ${queueImageIsListable(Prisma.sql`pl."targetId"`)}
  `;

  return row?.count ?? 0;
}

export async function getRemixGalleryVisibility({
  hostImageId,
  browsingLevel,
  viewerId,
  domainLevels,
}: {
  hostImageId: number;
  browsingLevel: number;
  /** Decides whether the pending count is computed at all. */
  viewerId?: number;
  /** Levels this domain may serve. Rows above it come back without their asset. */
  domainLevels: number;
}) {
  const [space, hasEntries, host] = await Promise.all([
    resolvePlacementSpaceFor({ surface: SURFACE, targetType: TARGET_TYPE, targetId: hostImageId }),
    galleryHasEntries({ hostImageId, browsingLevel }),
    readHostImage(hostImageId),
  ]);

  // Counted here rather than by a second round trip from the card, and only for
  // the owner — it is the one number that makes the panel actionable, and
  // nobody else may know how many submissions someone is sitting on. The card
  // already awaits this query, so for every other viewer this costs nothing.
  //
  // Counts what the queue can actually render, not every pending row. A bare
  // count counts submissions whose image is deleted, unpublished, mid-ingestion
  // or filtered, and the queue drops exactly those — so the badge said 2 over a
  // list that showed none, and the owner went looking for work that was not
  // there. The escrow behind a row that cannot be listed is released by the
  // expiry sweep rather than by a decision nobody could make.
  const pendingCount =
    viewerId && viewerId === space.ownerId
      ? await countListablePendingSubmissions({ hostImageId, ownerId: space.ownerId })
      : 0;

  // The submitter's own pending rows. Without this, submitting shows nothing at
  // all on the image it was sent to — the money left and the page looked
  // unchanged. Skipped for the owner, whose pending view is the queue above.
  const viewerPending =
    viewerId && viewerId !== space.ownerId
      ? await getViewerPendingSubmissions({
          hostImageId,
          viewerId,
          domainLevels,
          viewerLevels: browsingLevel,
        })
      : [];

  // The ceiling the picker filters on, so a submitter is not offered an image the
  // mutation will refuse — and, for a minor-flagged host, is not shown a grid of
  // their own mature work next to a Submit button.
  //
  // Withheld from anyone who cannot act on it. Under the `any` rule this number
  // is 2 only when the host carries a minor flag, so returning it unconditionally
  // from a public query turned every image id into a one-call oracle for another
  // user's moderation state — including an *unresolved* review on an image the
  // caller cannot even view. The refusal message on the mutation is anonymised
  // for exactly that reason; this would have shipped the same fact as a number.
  // Signed in, gallery open, not your own: the case the picker needs and nothing
  // wider.
  const canSubmitHere =
    !!viewerId && space.mode !== 'off' && viewerId !== space.ownerId && !!host?.showable;
  const maxSubmissionLevel = canSubmitHere
    ? remixGalleryMaxSubmissionLevel({
        rule: remixGalleryContentRule(space.settings),
        hostLevel: host?.nsfwLevel ?? 0,
        // A host row that no longer resolves fails closed rather than lifting the
        // ceiling.
        hostMinor: host?.minor ?? true,
      })
    : null;

  // The same ceiling, for the owner instead of the submitter. `maxSubmissionLevel`
  // is withheld from them by the rule above, which is right for every other
  // caller and leaves the review UI unable to say what its own gallery accepts.
  // Named apart so that rule keeps its contract: this is the owner's setting
  // applied to the owner's image, and tells them nothing they did not set.
  const acceptedMaxLevel =
    viewerId && viewerId === space.ownerId
      ? remixGalleryMaxSubmissionLevel({
          rule: remixGalleryContentRule(space.settings),
          hostLevel: host?.nsfwLevel ?? 0,
          hostMinor: host?.minor ?? true,
        })
      : null;

  // The owner's name and cut, so the submit button can say where the money goes
  // without the copy asserting it. The shares are operator-tunable at runtime,
  // so a string compiled against today's split is a claim about money that can
  // quietly stop being true — the same reason `ResolvedPlacementSpace` carries
  // `ownerShare` at all.
  const owner = await dbRead.user.findUnique({
    where: { id: space.ownerId },
    select: { username: true },
  });

  // The actual Buzz a decline would cost, not a percentage the reader has to
  // apply themselves. Computed with the same helper the refund uses, from the
  // same operator-set rate, so the number quoted before paying is the number
  // charged — a hardcoded 30% would be a promise this layer cannot keep.
  const declineFeeRate = (await getPlacementConfig()).declineFeeRate(SURFACE);
  const declineFee = space.price == null ? null : declineFeeAmount(space.price, declineFeeRate);

  return {
    open: space.mode !== 'off',
    hasEntries,
    render: space.mode !== 'off' || hasEntries,
    price: space.price,
    ownerId: space.ownerId,
    ownerUsername: owner?.username ?? null,
    ownerShare: space.ownerShare,
    // What the creator accepts is theirs to publish — it is a setting on their
    // own image, the same standing as `price`.
    freeSlots: space.freeSlots,
    // How many are currently *held* is not. It is a count of pending and
    // approved submissions on someone's image, which is the fact `pendingCount`
    // above is owner-only to protect — a public number here would let anyone
    // watch a creator's queue fill by polling an id.
    //
    // Withheld under the same rule as `maxSubmissionLevel`: signed in, gallery
    // open, not your own. That is exactly the case the submit card needs, and
    // nothing wider. `freeSlots` alone still tells a signed-out viewer whether
    // the creator takes free submissions at all.
    //
    // Both are needed together because `freeSlotsRemaining: 0` means two things
    // — the resolver short-circuits the reservation count at zero capacity — and
    // the two need different copy: one is a setting, the other is a queue.
    freeSlotsRemaining: canSubmitHere ? space.freeSlotsRemaining : null,
    declineFee,
    pendingCount,
    viewerPending,
    maxSubmissionLevel,
    acceptedMaxLevel,
  };
}

/**
 * Where the viewer stands on submitting to this gallery for free.
 *
 * **Every number here is a listing.** The allowance, the slot count and the
 * verification are all stale the moment they return, and the refusals live in
 * `createRemixGallerySubmission` and `createFreePlacement`. This exists so the
 * submit card can offer the free option and say what it costs, not so anything
 * can be decided on it — a control that defaults to free has to survive losing
 * the race for the last slot.
 *
 * Scoped to `imageIds` the picker has already loaded rather than sweeping the
 * viewer's library: a submitter with tens of thousands of images would otherwise
 * pay for a containment scan over all of them to render one badge.
 *
 * And scoped to the viewer's **own** images, which is not only about relevance:
 * answering "was this image generated from that one" for arbitrary ids would
 * turn the endpoint into an oracle for other people's generation inputs.
 */
export async function getRemixGalleryFreeEligibility({
  hostImageId,
  placerId,
  imageIds,
}: {
  hostImageId: number;
  placerId: number;
  /** The candidates on screen. Bounded by the schema. */
  imageIds: number[];
}) {
  const [allowance, usedHere, verified] = await Promise.all([
    getFreePlacementAllowance({ placerId }),
    hasUsedFreePlacementOn({
      placerId,
      surface: SURFACE,
      targetType: TARGET_TYPE,
      targetId: hostImageId,
    }),
    imageIds.length
      ? dbRead.$queryRaw<{ id: number }[]>`
          SELECT i.id
          FROM "Image" i
          WHERE i.id IN (${Prisma.join(imageIds)})
            AND i."userId" = ${placerId}
            -- The same fact the mutation gates on, through the same expression
            -- rather than a second reading of the same JSON: ids that
            -- sanitizeProvenance wrote after verifying a signed token or the
            -- workflow itself. A submitter editing their own image's meta cannot
            -- put one here, which is what makes the free gate mean anything.
            AND ${hostImageId} = ANY(${sourceImageIdsSql()})
        `
      : [],
  ]);

  return {
    allowance,
    /** Free is once per gallery per placer, ever — not once per day. */
    usedHere,
    verifiedImageIds: verified.map((row) => row.id),
  };
}

/**
 * The owner's review queue for this surface.
 *
 * Submissions whose image has since been deleted or unpublished are dropped: the
 * owner cannot judge what they cannot see, and the escrow behind those is
 * released by the expiry sweep rather than by an owner decision.
 */
export async function getPendingRemixGallerySubmissions({
  ownerId,
  hostImageId,
  limit = PLACEMENT_QUEUE_PAGE_SIZE,
  cursor,
  domainLevels,
  viewerLevels,
}: {
  ownerId: number;
  /** Levels this domain may serve. Rows above it come back without their asset. */
  domainLevels: number;
  /** The viewer own band. Marked on each row, never filtered on. */
  viewerLevels: number;
  /**
   * Scopes the queue to one gallery. Filtering client-side instead meant an
   * owner with 50 submissions elsewhere saw "nothing waiting" on an image that
   * had some: the limit truncated the list before the filter ever ran.
   */
  hostImageId?: number;
  limit?: number;
  cursor?: string | null;
}) {
  const keyset = parsePlacementQueueCursor(cursor);

  // Selected in SQL rather than paged and then filtered in memory. Filtering
  // after the fact pages over rows the queue cannot render: a queue of 66 whose
  // first 50 are unlistable returned 4 items with a cursor — "4+" over a page
  // size of 50 — and "load more" then produced 2. The page is now 50 listable
  // rows or the end of the queue, and `hasNextPage` means what it says.
  const listable = await dbRead.$queryRaw<{ id: number; createdAt: Date }[]>`
    SELECT pl.id, pl."createdAt"
    FROM "Placement" pl
    WHERE pl.surface = ${SURFACE}
      AND pl."ownerId" = ${ownerId}
      AND pl.status = 'pending'
      ${
        hostImageId
          ? Prisma.sql`AND pl."targetType" = ${TARGET_TYPE} AND pl."targetId" = ${hostImageId}`
          : Prisma.empty
      }
      ${
        keyset
          ? Prisma.sql`AND (pl."createdAt" > ${keyset.createdAt}
              OR (pl."createdAt" = ${keyset.createdAt} AND pl.id > ${keyset.id}))`
          : Prisma.empty
      }
      AND ${queueImageIsListable(Prisma.sql`(pl.data ->> 'imageId')::int`)}
      AND ${queueImageIsListable(Prisma.sql`pl."targetId"`)}
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
      placerId: true,
      amount: true,
      // Without it the queue cannot tell a free submission from a paid one, and
      // the earnings below — both computed from `amount`, which a free row
      // pins at 0 — render as "+0 Buzz" on approve AND decline. That is the
      // decision surface for the whole free tier telling a creator they earn
      // nothing, on the same row the free notification told them was a gift.
      free: true,
      data: true,
      createdAt: true,
      expiresAt: true,
      placer: { select: { id: true, username: true, image: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

  const entries = rows.filter((row) => isRemixGalleryPlacementData(row.data));
  const imageIds = entries.map((row) => (row.data as RemixGalleryPlacementData).imageId);
  if (!imageIds.length) return { items: [], nextCursor };

  // The host image rides along in the same fetch: the reviewer is judging a
  // remix against what it remixed, and a queue that shows only the submission
  // asks them to decide from memory. Same visibility filter either way — an
  // owner's own image reaching this list unpublished or unscanned renders as a
  // placeholder rather than as content this query vouched for.
  const lookupIds = [...new Set([...imageIds, ...entries.map((row) => row.targetId)])];

  const images = await dbRead.$queryRaw<
    {
      id: number;
      url: string;
      width: number | null;
      height: number | null;
      type: MediaType;
      // Carried because the review queue renders these through the shared image
      // card, which needs it to size and decode the media.
      metadata: MixedObject | null;
      nsfwLevel: number;
    }[]
  >`
    SELECT i.id, i.url, i.width, i.height, i.type, i.metadata, i."nsfwLevel"
    FROM "Image" i
    JOIN "Post" p ON p.id = i."postId"
    WHERE i.id IN (${Prisma.join(lookupIds)})
      AND p."publishedAt" IS NOT NULL
      AND i.ingestion = 'Scanned'
      AND NOT i."tosViolation"
        AND NOT i.minor
        AND NOT i.poi
  `;
  const byId = new Map(images.map((image) => [image.id, image]));

  // What each answer actually pays the owner, computed per row with the same
  // helpers the settlement uses. The row's own `amount` rather than the space's
  // current price — the price can move after a submission — and the live rates
  // rather than the defaults, so the number on the button is the number paid.
  const config = await getPlacementConfig();
  const shares = config.approvalShares(SURFACE);
  const declineFeeRate = config.declineFeeRate(SURFACE);

  return {
    items: entries
      .map((row) => ({
        ...row,
        data: row.data as RemixGalleryPlacementData,
        image: toQueueImage(
          byId.get((row.data as RemixGalleryPlacementData).imageId),
          domainLevels,
          viewerLevels
        ),
        targetImage: toQueueImage(byId.get(row.targetId), domainLevels, viewerLevels),
        // `null` on a free row rather than the zeroes the arithmetic produces.
        // Nothing was paid in, so there is no split and no decline fee — and a
        // "+0 Buzz" chip does not say that, it says this creator earns nothing
        // for accepting, which is both false in spirit and about to be false in
        // fact once the accept reward lands. The absence is what lets the queue
        // render something else instead of a number.
        earnings: row.free
          ? null
          : {
              approve: splitPlacementPayment({
                amount: row.amount,
                outcome: 'approved',
                declineFeeRate,
                sellerShare: shares.seller,
                platformShare: shares.platform,
              }).toOwner,
              decline: declineFeeAmount(row.amount, declineFeeRate),
            },
      }))
      // Both halves, for the same reason: the owner cannot judge a remix they
      // cannot see, and cannot judge it against a host that no longer renders.
      // `countListablePendingSubmissions` applies the identical pair, so the
      // badge and this list cannot disagree.
      .filter((row) => row.image && row.targetImage),
    nextCursor,
  };
}

/**
 * The submitter's own view, so they can find and withdraw what they sent.
 *
 * Returns every row even when its image doesn't resolve. Filtering to visible
 * content like the owner queue above does would hide a submitter's own pending
 * row — and the withdraw that returns their escrow — the moment their image was
 * unpublished or flagged.
 */
export async function getMyRemixGallerySubmissions({
  placerId,
  limit = REMIX_GALLERY_QUEUE_LIMIT,
  domainLevels,
  viewerLevels,
}: {
  placerId: number;
  limit?: number;
  /** Levels this domain may serve. Rows above it come back without their asset. */
  domainLevels: number;
  /** The viewer own band. Marked on each row, never filtered on. */
  viewerLevels: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: { surface: SURFACE, placerId, status: { in: ['pending', 'approved'] } },
    select: {
      id: true,
      targetId: true,
      ownerId: true,
      status: true,
      amount: true,
      // The submitter's side of the same problem the owner queue had: `amount`
      // is 0 on a free row, so without this every Buzz figure and every "your
      // Buzz is on its way back" renders about money that never moved.
      free: true,
      data: true,
      createdAt: true,
      expiresAt: true,
      owner: { select: { id: true, username: true, image: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const imageIds = rows
    .filter((row) => isRemixGalleryPlacementData(row.data))
    .map((row) => (row.data as RemixGalleryPlacementData).imageId);

  const images = imageIds.length
    ? await dbRead.$queryRaw<
        {
          id: number;
          url: string;
          width: number | null;
          height: number | null;
          type: MediaType;
          metadata: MixedObject | null;
          nsfwLevel: number;
        }[]
      >`
        SELECT i.id, i.url, i.width, i.height, i.type, i.metadata, i."nsfwLevel"
        FROM "Image" i
        WHERE i.id IN (${Prisma.join(imageIds)})
      `
    : [];
  const byId = new Map(images.map((image) => [image.id, image]));

  // The host image is someone else's, so unlike the submitter's own image above
  // it is fetched under the same visibility filter the public feed applies. A
  // host that fails it renders as a placeholder; the row stays either way,
  // because the withdraw beside it is the only route back to the escrow.
  const targetIds = [...new Set(rows.map((row) => row.targetId))];
  const targetImages = targetIds.length
    ? await dbRead.$queryRaw<
        {
          id: number;
          url: string;
          width: number | null;
          height: number | null;
          type: MediaType;
          metadata: MixedObject | null;
          nsfwLevel: number;
        }[]
      >`
        SELECT i.id, i.url, i.width, i.height, i.type, i.metadata, i."nsfwLevel"
        FROM "Image" i
        JOIN "Post" p ON p.id = i."postId"
        WHERE i.id IN (${Prisma.join(targetIds)})
          AND p."publishedAt" IS NOT NULL
          AND i.ingestion = 'Scanned'
          AND NOT i."tosViolation"
          AND NOT i.minor
          AND NOT i.poi
      `
    : [];
  const targetById = new Map(targetImages.map((image) => [image.id, image]));

  return rows.map((row) => ({
    ...row,
    image: isRemixGalleryPlacementData(row.data)
      ? toQueueImage(
          byId.get((row.data as RemixGalleryPlacementData).imageId),
          domainLevels,
          viewerLevels
        )
      : null,
    targetImage: toQueueImage(targetById.get(row.targetId), domainLevels, viewerLevels),
  }));
}
