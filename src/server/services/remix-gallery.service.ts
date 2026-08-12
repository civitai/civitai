import { Prisma } from '@prisma/client';
import type { MediaType } from '~/shared/utils/prisma/enums';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { ImageSort } from '~/server/common/enums';
import type { SessionUser } from '~/types/session';
import { dbRead, dbWrite } from '~/server/db/client';
import { logToAxiom } from '~/server/logging/client';
import { getAllImages } from '~/server/services/image.service';
import { holdPlacementEscrow, settlePlacement } from '~/server/services/placement-escrow.service';
import { assertCanPlace } from '~/server/services/placement-moderation.service';
import { getPlacementConfig } from '~/server/services/placement.service';
import { resolvePlacementSpaceFor } from '~/server/services/placement-space.service';
import { throwAuthorizationError, throwBadRequestError } from '~/server/utils/errorHandling';
import { onlySelectableLevels } from '~/shared/constants/browsingLevel.constants';
import { declineFeeAmount, PLACEMENT_SURFACES } from '~/shared/utils/placement';
import type { RemixGalleryPlacementData } from '~/shared/utils/remix-gallery';
import {
  isRemixGalleryPlacementData,
  REMIX_GALLERY_MAX_PENDING_PER_OWNER,
  REMIX_GALLERY_MAX_PINNED,
  REMIX_GALLERY_PAGE_SIZE,
  remixGalleryContentRule,
  remixGalleryLevelAllowed,
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
           (i.meta -> 'extra' ->> 'remixOfId')::int AS "remixOfId"
    FROM "Image" i
    LEFT JOIN "Post" p ON p.id = i."postId"
    WHERE i.id = ${imageId}
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
};

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
 * placed is content the submitter already owns.
 */
export async function createRemixGallerySubmission({
  placerId,
  hostImageId,
  imageId,
  expectedPrice,
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

  if (space.price == null)
    throw throwBadRequestError('remix gallery: this creator has not set a price yet');

  // `setPlacementSpace` refuses to write a price below the floor, but it lets an
  // existing lower one be carried, so a row predating the rule still reads back
  // here — and the floor is the only spam gate this surface has, since nothing
  // verifies a submission is really a remix. Refused rather than rounded up:
  // charging more than the number the submitter was shown is the thing
  // `expectedPrice` below exists to prevent.
  if (space.price < PLACEMENT_SURFACES[SURFACE].minPrice)
    throw throwBadRequestError('remix gallery: this gallery is not priced for submissions');

  // Refused rather than charged. The client can only check affordability against
  // the number it rendered, so charging a price the submitter never saw is a
  // spend without consent — and an owner can move their price at any time.
  if (expectedPrice != null && expectedPrice !== space.price)
    throw throwBadRequestError(
      `remix gallery: the price changed to ${space.price} Buzz while you were deciding`
    );

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

  const [host] = await dbWrite.$queryRaw<{ nsfwLevel: number }[]>`
    SELECT "nsfwLevel" FROM "Image" WHERE id = ${hostImageId}
  `;
  if (!host) throw throwBadRequestError('remix gallery: that image no longer exists');

  const rule = remixGalleryContentRule(space.settings);
  if (
    !remixGalleryLevelAllowed({
      rule,
      submissionLevel: submission.nsfwLevel,
      hostLevel: host.nsfwLevel,
    })
  )
    throw throwBadRequestError(
      rule === 'any'
        ? 'remix gallery: that image has no rating yet'
        : "remix gallery: this creator only accepts submissions rated at or below their image's rating"
    );

  await assertCanPlace({ ownerId: space.ownerId, placerId });

  const pending = await dbWrite.placement.count({
    where: { surface: SURFACE, ownerId: space.ownerId, placerId, status: 'pending' },
  });
  if (pending >= REMIX_GALLERY_MAX_PENDING_PER_OWNER)
    throw throwBadRequestError(
      'remix gallery: you already have the maximum submissions waiting with this creator'
    );

  await assertNotAlreadySubmitted({ hostImageId, imageId });

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
      data: {
        imageId,
        remixOfId: submission.remixOfId,
      } satisfies RemixGalleryPlacementData,
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
}: {
  placementId: number;
  action: OwnerAction;
  userId: number;
  isModerator?: boolean;
}) {
  const placement = await dbWrite.placement.findUnique({
    where: { id: placementId },
    select: {
      id: true,
      ownerId: true,
      status: true,
      surface: true,
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
    // A moderator is exempt: a takedown is a moderation record rather than an
    // owner decision, and the abusive cases are the ones that must not wait.
    const isModeratorTakedown = isModerator && placement.ownerId !== userId;
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
          `remix gallery: this entry can be removed from ${removableAt.toISOString()}. Someone paid to be featured here, so it stays up for a week after you approve it.`
        );
    }

    const { count } = await dbWrite.placement.updateMany({
      where: { id: placementId, status: 'approved' },
      data: {
        status: 'removed',
        // A moderator acting on someone else's gallery is a moderation record,
        // not an owner decision, and the two refund differently everywhere else
        // in this system. Recording it as `owner` would misattribute it.
        removedBy: isModerator && placement.ownerId !== userId ? 'moderator' : 'owner',
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

  const result = await settlePlacement({
    placementId,
    action: action === 'approve' ? 'approve' : 'decline',
    actorId: userId,
  });

  // `settlePlacement` claims its transition with `WHERE status = 'pending'`, so
  // a race against the expiry sweep or a block moves no money and returns
  // `settled: false`. Reported rather than swallowed: a moderator action that
  // appeared to work and did not is what this cost us on chunk D.
  if (!result.settled)
    throw throwBadRequestError('remix gallery: that submission was already resolved elsewhere');

  return result;
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

  const [host] = await dbWrite.$queryRaw<{ nsfwLevel: number }[]>`
    SELECT "nsfwLevel" FROM "Image" WHERE id = ${placement.targetId}
  `;
  if (!host) throw throwBadRequestError('remix gallery: that image no longer exists');

  if (
    !remixGalleryLevelAllowed({
      rule: remixGalleryContentRule(space.settings),
      submissionLevel: submission.nsfwLevel,
      hostLevel: host.nsfwLevel,
    })
  )
    // Names both possibilities, because the rule is as likely to have moved as
    // the rating: an owner who tightens their content rule after submissions
    // arrive gets this on approval, and blaming the image would send them
    // looking at the wrong thing.
    throw throwBadRequestError(
      "remix gallery: that image's rating no longer fits this gallery's content rule"
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
        AND i."nsfwLevel" != 0
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
        AND i."nsfwLevel" != 0
    ) AS "exists"
  `;

  return row?.exists ?? false;
}

export async function getRemixGalleryVisibility({
  hostImageId,
  browsingLevel,
  viewerId,
}: {
  hostImageId: number;
  browsingLevel: number;
  /** Decides whether the pending count is computed at all. */
  viewerId?: number;
}) {
  const [space, hasEntries] = await Promise.all([
    resolvePlacementSpaceFor({ surface: SURFACE, targetType: TARGET_TYPE, targetId: hostImageId }),
    galleryHasEntries({ hostImageId, browsingLevel }),
  ]);

  // Counted here rather than by a second round trip from the card, and only for
  // the owner — it is the one number that makes the panel actionable, and
  // nobody else may know how many submissions someone is sitting on. The card
  // already awaits this query, so for every other viewer this costs nothing.
  const pendingCount =
    viewerId && viewerId === space.ownerId
      ? await dbRead.placement.count({
          where: {
            surface: SURFACE,
            targetType: TARGET_TYPE,
            targetId: hostImageId,
            ownerId: space.ownerId,
            status: 'pending',
          },
        })
      : 0;

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
    declineFee,
    pendingCount,
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
  limit = 50,
}: {
  ownerId: number;
  /**
   * Scopes the queue to one gallery. Filtering client-side instead meant an
   * owner with 50 submissions elsewhere saw "nothing waiting" on an image that
   * had some: the limit truncated the list before the filter ever ran.
   */
  hostImageId?: number;
  limit?: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: {
      surface: SURFACE,
      ownerId,
      status: 'pending',
      ...(hostImageId ? { targetType: TARGET_TYPE, targetId: hostImageId } : {}),
    },
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

  const entries = rows.filter((row) => isRemixGalleryPlacementData(row.data));
  const imageIds = entries.map((row) => (row.data as RemixGalleryPlacementData).imageId);
  if (!imageIds.length) return [];

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
    WHERE i.id IN (${Prisma.join(imageIds)})
      AND p."publishedAt" IS NOT NULL
      AND i.ingestion = 'Scanned'
      AND NOT i."tosViolation"
        AND NOT i.minor
        AND NOT i.poi
  `;
  const byId = new Map(images.map((image) => [image.id, image]));

  return entries
    .map((row) => ({
      ...row,
      data: row.data as RemixGalleryPlacementData,
      image: byId.get((row.data as RemixGalleryPlacementData).imageId) ?? null,
    }))
    .filter((row) => row.image);
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
  limit = 50,
}: {
  placerId: number;
  limit?: number;
}) {
  const rows = await dbRead.placement.findMany({
    where: { surface: SURFACE, placerId, status: { in: ['pending', 'approved'] } },
    select: {
      id: true,
      targetId: true,
      ownerId: true,
      status: true,
      amount: true,
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

  return rows.map((row) => ({
    ...row,
    image: isRemixGalleryPlacementData(row.data)
      ? byId.get((row.data as RemixGalleryPlacementData).imageId) ?? null
      : null,
  }));
}
