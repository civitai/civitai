import type { Prisma } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import {
  loadListingRatingAssets,
  recordListingRatingChange,
  resolveReDerivedListingRating,
} from '~/server/services/blocks/app-listing-rating';
import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';

export type ListingRatingReDerive = {
  appListingId: string;
  before: string | null;
  after: string | null;
};

/**
 * Re-derive one listing's rating inside `tx`. Returns the change, or `null` when the listing
 * is not live, no longer uses the image, or its rating should stand.
 */
export async function reDeriveListingRatingInTx(
  tx: Prisma.TransactionClient,
  args: {
    appListingId: string;
    imageId: number;
    previousNsfwLevel: number | null;
    actorUserId: number | null;
  }
): Promise<ListingRatingReDerive | null> {
  // The row lock serializes this against a moderator's live asset edit and a revision apply
  // (both write this row first), so the assets read below cannot change before the write.
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
    declared: listing.kind === 'onsite' ? listing.appBlock?.contentRating ?? null : null,
    assets,
    reratedImageId: args.imageId,
    previousNsfwLevel: args.previousNsfwLevel,
  });
  if (after == null) return null;

  await tx.appListing.update({
    where: { id: args.appListingId },
    data: { contentRating: after },
  });
  await recordListingRatingChange(tx, {
    appListingId: args.appListingId,
    slug: listing.slug,
    before: listing.contentRating,
    after,
    cause: 'image-review',
    actorUserId: args.actorUserId,
    imageIds: [args.imageId],
  });
  return { appListingId: args.appListingId, before: listing.contentRating, after };
}

/**
 * A MODERATOR set an image's level: bring the rating of every live listing that uses the
 * image (as icon, cover or screenshot) back in line with it. See
 * `resolveReDerivedListingRating` for when a rating may move, and in which direction.
 *
 * Never throws. Each listing gets its own transaction, in which the rating write and its
 * history event commit together, so a failure leaves that one listing exactly as it was and
 * is logged; the caller's image re-rate has already committed and must not be undone by a
 * store-card side effect.
 */
export async function reDeriveListingRatingsForModeratedImage(args: {
  imageId: number;
  /** The image's level BEFORE the moderator's write. Without it nothing is lowered. */
  previousNsfwLevel: number | null;
  actorUserId: number | null;
}): Promise<ListingRatingReDerive[]> {
  const changed: ListingRatingReDerive[] = [];
  try {
    // Primary, not the replica: a listing approved a moment ago must not be missed when
    // the moderator's write RAISED the image.
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
        const result = await dbWrite.$transaction((tx) =>
          reDeriveListingRatingInTx(tx, { ...args, appListingId })
        );
        if (result) changed.push(result);
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
    `[listing-rating] re-derive after a moderator re-rated image ${imageId} failed (${what}); the listing rating is unchanged: ` +
      (err instanceof Error ? err.message : String(err))
  );
}
