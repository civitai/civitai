import type { Prisma } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import {
  loadListingRatingAssets,
  recordListingRatingChange,
  resolveReDerivedListingRating,
} from '~/server/services/blocks/app-listing-rating';
import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';

export type ListingRatingReDerive = {
  appListingId: string;
  before: string | null;
  after: string | null;
};

type ReDeriveArgs = {
  imageId: number;
  /** The image's level BEFORE the write. Without it nothing is lowered. */
  previousNsfwLevel: number | null;
  actorUserId: number | null;
  /**
   * Whether this write may LOWER a listing. A moderator's own decision may; a Knights
   * consensus is a vote and may only raise.
   */
  allowLower: boolean;
};

type ReDeriveOutcome = ListingRatingReDerive & { slug: string; historyWritten: boolean };

const historyEvent = (args: ReDeriveArgs, outcome: ReDeriveOutcome) => ({
  appListingId: outcome.appListingId,
  slug: outcome.slug,
  before: outcome.before,
  after: outcome.after,
  cause: 'image-review' as const,
  actorUserId: args.actorUserId,
  imageIds: [args.imageId],
});

/**
 * Re-derive one listing's rating inside `tx`. Returns the change, or `null` when the listing
 * is not live, no longer uses the image, or its rating should stand.
 *
 * A LOWERING writes its history event here, so the two commit or roll back together: a
 * maturity gate must not open with no record of why. A RAISE leaves the event to the caller
 * (`historyWritten: false`), so that a rejected insert cannot roll back a tightening.
 */
export async function reDeriveListingRatingInTx(
  tx: Prisma.TransactionClient,
  args: ReDeriveArgs & { appListingId: string }
): Promise<ReDeriveOutcome | null> {
  // The row lock is what stops the assets read below changing before the write: every
  // writer of a live listing's asset set either updates this row (icon, cover, a revision
  // apply) or inserts a screenshot whose foreign key takes a share lock on it.
  // It is also the authority on "live": a listing that left `approved`, or a shadow
  // revision, matches nothing and is left to its own approve to rate.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id"
    FROM "app_listings"
    WHERE "id" = ${args.appListingId} AND "status" = 'approved' AND "revision_of_id" IS NULL
    FOR UPDATE
  `;
  if (locked.length === 0) return null;

  const listing = await tx.appListing.findUnique({
    where: { id: args.appListingId },
    select: {
      slug: true,
      kind: true,
      contentRating: true,
      appBlock: { select: { contentRating: true } },
    },
  });
  if (!listing) return null;

  const assets = await loadListingRatingAssets(tx, args.appListingId);
  if (!assets.some((a) => a.imageId === args.imageId)) return null;

  const after = resolveReDerivedListingRating({
    stored: listing.contentRating,
    declared:
      args.allowLower && listing.kind === 'onsite' ? listing.appBlock?.contentRating ?? null : null,
    assets,
    reratedImageId: args.imageId,
    previousNsfwLevel: args.previousNsfwLevel,
  });
  if (after == null) return null;

  await tx.appListing.update({
    where: { id: args.appListingId },
    data: { contentRating: after },
  });
  const outcome: ReDeriveOutcome = {
    appListingId: args.appListingId,
    slug: listing.slug,
    before: listing.contentRating,
    after,
    historyWritten: false,
  };
  if (nsfwLevelFromContentRating(after) < nsfwLevelFromContentRating(listing.contentRating)) {
    await recordListingRatingChange(tx, historyEvent(args, outcome));
    outcome.historyWritten = true;
  }
  return outcome;
}

/**
 * An image's level was set by a moderator (or a Knights consensus): bring the rating of
 * every live listing that uses the image (as icon, cover or screenshot) back in line with
 * it. See `resolveReDerivedListingRating` for when a rating may move, and in which direction.
 *
 * Never throws. Each listing gets its own transaction; a failure leaves that one listing
 * exactly as it was and is logged. The caller's image write has already committed and must
 * not be undone by a store-card side effect.
 */
export async function reDeriveListingRatingsForModeratedImage(
  args: ReDeriveArgs
): Promise<ListingRatingReDerive[]> {
  const changed: ListingRatingReDerive[] = [];
  try {
    // Primary, not the replica: a listing approved a moment ago must not be missed when
    // the write RAISED the image.
    const candidates = await dbWrite.appListing.findMany({
      where: {
        status: 'approved',
        revisionOfId: null,
        OR: [
          { iconId: args.imageId },
          { coverId: args.imageId },
          { screenshots: { some: { imageId: args.imageId } } },
        ],
      },
      select: { id: true },
    });
    for (const { id: appListingId } of candidates) {
      try {
        const outcome = await dbWrite.$transaction((tx) =>
          reDeriveListingRatingInTx(tx, { ...args, appListingId })
        );
        if (!outcome) continue;
        changed.push({
          appListingId: outcome.appListingId,
          before: outcome.before,
          after: outcome.after,
        });
        if (!outcome.historyWritten)
          await recordListingRatingChange(dbWrite, historyEvent(args, outcome));
      } catch (err) {
        logReDeriveFailure(`listing ${appListingId}`, args.imageId, err);
      }
    }
  } catch (err) {
    logReDeriveFailure('listing lookup', args.imageId, err);
  }
  if (changed.length > 0) await bustAppListingCatalogCache().catch(() => undefined);
  return changed;
}

function logReDeriveFailure(what: string, imageId: number, err: unknown) {
  // eslint-disable-next-line no-console
  console.warn(
    `[listing-rating] re-derive after image ${imageId} was re-rated failed (${what}): ` +
      (err instanceof Error ? err.message : String(err))
  );
}
