import type { Prisma } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import {
  loadListingRatingAssets,
  RATING_CHANGE_ACTION,
  recordListingRatingChange,
  resolveReDerivedListingRating,
} from '~/server/services/blocks/app-listing-rating';
import { bustAppListingCatalogCache } from '~/server/services/blocks/app-listing.service';
import {
  listListingIdsWithRedSlotImage,
  readListingMediaSplit,
} from '~/server/services/blocks/listing-media-split.service';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';
import { appDeclaredListingRating } from '~/shared/utils/listing-rating-display';

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
};

type ReDeriveOutcome = ListingRatingReDerive & { slug: string; historyWritten: boolean };

const historyEvent = (args: ReDeriveArgs, outcome: ReDeriveOutcome) => ({
  appListingId: outcome.appListingId,
  slug: outcome.slug,
  before: outcome.before,
  after: outcome.after,
  cause: 'image-review' as const,
  actorUserId: args.actorUserId,
});

/** The rating the listing's newest review decided, read under the row lock. */
async function readReviewedRating(
  tx: Prisma.TransactionClient,
  appListingId: string
): Promise<string | null> {
  const event = await tx.appListingModerationEvent.findFirst({
    where: { appListingId, action: RATING_CHANGE_ACTION, detail: 'review' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { after: true },
  });
  const after = event?.after as { contentRating?: unknown } | null | undefined;
  return typeof after?.contentRating === 'string' ? after.contentRating : null;
}

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
  // The row lock stops the assets read below gaining an image before the write: every writer
  // that can ADD one to a live listing's asset set either updates this row (icon, cover, a
  // revision apply), inserts a screenshot whose foreign key takes a share lock on it, or sets a
  // civitai.red override slot, which takes a key-share lock on it first (`writeListingRedSlot`).
  // A removal takes no lock, but it only shrinks the set, so a stale read errs toward keeping
  // the rating.
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
    declared: appDeclaredListingRating({
      kind: listing.kind,
      appRating: listing.appBlock?.contentRating,
    }),
    assets,
    reratedImageId: args.imageId,
    previousNsfwLevel: args.previousNsfwLevel,
    reviewedRating: await readReviewedRating(tx, args.appListingId),
    mediaSplit: await readListingMediaSplit(tx, args.appListingId),
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
 * A moderator set an image's level: bring the rating of every live listing that uses the
 * image (as icon, cover, screenshot or civitai.red icon / cover override) back in line with it. See `resolveReDerivedListingRating` for when a rating may move, and in which direction.
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
    // the moderator RAISED the image.
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
    // The overrides live outside `app_listings`; `reDeriveListingRatingInTx` itself skips any
    // that is not a live, non-shadow listing.
    const ids = [
      ...new Set([
        ...candidates.map((c) => c.id),
        ...(await listListingIdsWithRedSlotImage(dbWrite, args.imageId)),
      ]),
    ];
    for (const appListingId of ids) {
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
