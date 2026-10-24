import type { Prisma } from '@prisma/client';

import { dbWrite } from '~/server/db/client';
import type { APP_LISTING_MODERATION_ACTIONS } from '~/server/schema/blocks/offsite-moderation.schema';
import { newAppListingModerationEventId } from '~/server/utils/app-block-ids';
import {
  deriveContentRatingFromAssets,
  isOffsiteContentRating,
  nsfwLevelFromContentRating,
  offsiteContentRatingLabel,
} from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import {
  readListingMediaSplit,
  readListingRedSlotAssets,
} from '~/server/services/blocks/listing-media-split.service';
import { ratingFloorAssets } from '~/shared/utils/listing-media-split';

export const RATING_CHANGE_ACTION =
  'rating-change' satisfies (typeof APP_LISTING_MODERATION_ACTIONS)[number];

/**
 * Why a listing's stored rating moved. Stored in the event's `detail`.
 *   - `store-media`  — a go-live or moderator asset edit floored the rating at its media.
 *   - `image-review` — a moderator re-rated one of the listing's images.
 *   - `review`       — any other go-live move: a review's derive-and-replace or override.
 *                      The newest one is a floor a re-rated image may not lower past.
 */
export type ListingRatingChangeCause = 'store-media' | 'image-review' | 'review';

/** One attached asset. A missing Image row is `{ nsfwLevel: null, ingestion: null }`. */
export type ListingRatingAsset = {
  imageId: number;
  nsfwLevel: number | null;
  ingestion: string | null;
  /** A civitai.red icon / cover override (`ratingFloorAssets` leaves it out of a split's floor). */
  redSlot?: boolean;
};

type RatingEventWriter = Pick<Prisma.TransactionClient, 'appListingModerationEvent'>;
type RatingAssetReader = Pick<
  Prisma.TransactionClient,
  'appListing' | 'appListingScreenshot' | 'image' | '$queryRaw'
>;

const ratingLabel = (rating: string | null) =>
  rating == null ? 'unrated' : offsiteContentRatingLabel(rating);

/**
 * The sentence the listing OWNER reads: their history shows an event's `reason` and nothing
 * else of it, so the before/after has to be spelled out here.
 */
export function listingRatingChangeReason(args: {
  before: string | null;
  after: string | null;
  cause: ListingRatingChangeCause;
}): string {
  const before = ratingLabel(args.before);
  const after = ratingLabel(args.after);
  if (args.cause === 'store-media')
    return `Rating changed ${before} → ${after}: store imagery was rated ${after}.`;
  if (args.cause === 'review') return `Rating changed ${before} → ${after} at review.`;
  const lowered = nsfwLevelFromContentRating(args.after) < nsfwLevelFromContentRating(args.before);
  return `Rating ${
    lowered ? 'lowered' : 'raised'
  } ${before} → ${after} after a moderator reviewed an image.`;
}

/**
 * The one writer of `rating-change` events. Writes nothing when the value did not change.
 * Throws on a failed insert: an in-transaction caller wants the rollback, a post-commit one
 * uses {@link recordListingRatingChangeAfterCommit}.
 */
export async function recordListingRatingChange(
  db: RatingEventWriter,
  args: {
    appListingId: string;
    slug: string;
    before: string | null;
    after: string | null;
    cause: ListingRatingChangeCause;
    actorUserId: number | null;
  }
): Promise<boolean> {
  if (args.before === args.after) return false;
  await db.appListingModerationEvent.create({
    data: {
      id: newAppListingModerationEventId(),
      appListingId: args.appListingId,
      slug: args.slug,
      action: RATING_CHANGE_ACTION,
      actorUserId: args.actorUserId,
      reason: listingRatingChangeReason(args),
      detail: args.cause,
      before: { contentRating: args.before },
      after: { contentRating: args.after },
    },
  });
  return true;
}

/**
 * A listing's attached assets (icon, cover, screenshots, then its civitai.red icon / cover
 * overrides, marked `redSlot`) with their current levels. An image used both in its own slot and
 * as an override appears once for each, so a split, which drops the override, still keeps it.
 */
export async function loadListingRatingAssets(
  db: RatingAssetReader,
  appListingId: string
): Promise<ListingRatingAsset[]> {
  const listing = await db.appListing.findUnique({
    where: { id: appListingId },
    select: { iconId: true, coverId: true },
  });
  if (!listing) return [];
  const shots = await db.appListingScreenshot.findMany({
    where: { appListingId, imageId: { not: null } },
    select: { imageId: true },
  });
  const redSlots: ListingRatingAsset[] = await readListingRedSlotAssets(db, appListingId);
  const imageIds = [
    ...new Set(
      [listing.iconId, listing.coverId, ...shots.map((s) => s.imageId)].filter(
        (v): v is number => v != null
      )
    ),
  ];
  if (imageIds.length === 0) return redSlots;
  const images = await db.image.findMany({
    where: { id: { in: imageIds } },
    select: { id: true, nsfwLevel: true, ingestion: true },
  });
  const byId = new Map(images.map((i) => [i.id, i]));
  return [
    ...imageIds.map((imageId) => ({
      imageId,
      nsfwLevel: byId.get(imageId)?.nsfwLevel ?? null,
      ingestion: byId.get(imageId)?.ingestion ?? null,
    })),
    ...redSlots,
  ];
}

/**
 * Record a rating change AFTER the write that made it has committed, and never throw.
 *
 * The go-live and asset-edit sites call this outside their transaction on purpose: the event
 * `action` is CHECK-constrained by a hand-applied migration, so an in-transaction insert on
 * an environment that lacks it would roll back the approval — or the safety raise — it
 * describes.
 */
export async function recordListingRatingChangeAfterCommit(args: {
  appListingId: string;
  slug: string;
  before: string | null;
  after: string | null;
  actorUserId: number | null;
}): Promise<void> {
  if (args.before === args.after) return;
  try {
    const assets = ratingFloorAssets(
      await loadListingRatingAssets(dbWrite, args.appListingId),
      await readListingMediaSplit(dbWrite, args.appListingId)
    );
    // A raise that lands exactly on what the media derives to is the media's doing; any
    // other move (a lowering, an override above the media) was the review's.
    const afterLevel = nsfwLevelFromContentRating(args.after);
    const mediaDriven =
      afterLevel > nsfwLevelFromContentRating(args.before) &&
      afterLevel === nsfwLevelFromContentRating(deriveContentRatingFromAssets(assets));
    await recordListingRatingChange(dbWrite, {
      ...args,
      cause: mediaDriven ? 'store-media' : 'review',
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[listing-rating] rating changed (${args.before} → ${args.after}) on ${args.appListingId} but its history event was not written: ` +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

// Stricter than `isImageReviewed` on purpose: a moderator's lock on an image whose scan never
// finished counts as reviewed for display, but must not be what lets a rating drop.
const isSettled = (asset: ListingRatingAsset) =>
  asset.ingestion === ImageIngestionStatus.Scanned && (asset.nsfwLevel ?? 0) > 0;

/**
 * The rating a listing should carry after a moderator re-rated one of its images, or `null`
 * to leave it alone.
 *
 * The target is `max(declared, derived from the current assets)`, where a split listing's
 * assets are only its civitai.com-eligible ones, judged by each image's level on the side of
 * the re-rate being compared (`ratingFloorAssets`). RAISING to it is
 * unconditional. LOWERING to it is the dangerous direction on a maturity gate, so it needs
 * all of:
 *   - a declared rating to floor at (see the `declared` parameter).
 *   - every asset scanned with a level: an unscanned, blocked or missing asset reads as the
 *     lowest level, and must not be what lets a rating drop.
 *   - the stored rating being exactly what the re-rated image's PREVIOUS level produced.
 *     Anything higher was put there by something this cannot see (a review override, an app
 *     that has since lowered its own declaration) and is not this image's to undo.
 *   - never going below the rating the listing's newest review decided (`reviewedRating`).
 *     The guard above checks consistency, not provenance: once a later re-rate has raised
 *     the media to a moderator's override, the image's previous level "explains" it, and
 *     only the recorded decision stops a correction from erasing the override.
 */
export function resolveReDerivedListingRating(args: {
  stored: string | null;
  /**
   * The rating the author declared, when one is kept apart from the stored value: an
   * on-site listing's backing app. `null` otherwise, which makes the listing raise-only —
   * an off-site listing's stored rating is the only record of what its review decided.
   */
  declared: string | null;
  assets: ListingRatingAsset[];
  reratedImageId: number;
  previousNsfwLevel: number | null;
  /** The `after` of the listing's newest `review` rating-change event, if any. */
  reviewedRating: string | null;
  mediaSplit: boolean;
}): string | null {
  const { stored } = args;
  const assets = ratingFloorAssets(args.assets, args.mediaSplit);
  const storedLevel = nsfwLevelFromContentRating(stored);
  // A declared value outside the ladder is no floor at all: it is never written back, and
  // it must not be read as the lowest rung, which would let a rating drop to it.
  const floor = isOffsiteContentRating(args.declared) ? args.declared : null;
  const floorLevel = floor ? nsfwLevelFromContentRating(floor) : 0;
  const derived = deriveContentRatingFromAssets(assets);
  const derivedLevel = nsfwLevelFromContentRating(derived);
  const target = floor && floorLevel >= derivedLevel ? floor : derived;
  const targetLevel = Math.max(derivedLevel, floorLevel);

  if (targetLevel > storedLevel) return target;
  if (targetLevel === storedLevel) return null;

  if (!floor) return null;
  if (!assets.every(isSettled)) return null;
  const derivedBefore = deriveContentRatingFromAssets(
    ratingFloorAssets(
      args.assets.map((a) =>
        // Spread, so a civitai.red override keeps its `redSlot` mark on the "before" side too.
        a.imageId === args.reratedImageId ? { ...a, nsfwLevel: args.previousNsfwLevel } : a
      ),
      args.mediaSplit
    )
  );
  if (Math.max(nsfwLevelFromContentRating(derivedBefore), floorLevel) !== storedLevel) return null;
  if (isOffsiteContentRating(args.reviewedRating)) {
    const reviewedLevel = nsfwLevelFromContentRating(args.reviewedRating);
    if (reviewedLevel > targetLevel)
      return reviewedLevel < storedLevel ? args.reviewedRating : null;
  }
  return target;
}
