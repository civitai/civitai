import type { Prisma } from '@prisma/client';

import { resolveListingRatingFloorInTx } from '~/server/services/blocks/app-listing-assets.service';
import { readListingMediaSplit } from '~/server/services/blocks/listing-media-split.service';
import { nsfwLevelFromContentRating } from '~/shared/constants/browsingLevel.constants';

/**
 * The rating an on-site listing gets when a new version of its app is approved
 * (`approveRequest`, (3b-sync)), and the one the approve bar previews
 * (`previewVersionListingRating`). One function, so the preview and the write cannot disagree.
 *
 * Normally: the new version's declared rating, raised to the store media's rating when that is
 * more mature (`resolveListingRatingFloorInTx`, the first approve's floor). That can LOWER the
 * listing, which the moderator approving the new manifest sees in the preview.
 *
 * 🔴 A MODERATOR'S RAISE IS KEPT. No override is stored for an on-site listing: a review's
 * override and a moderator's live-edit raise write only `contentRating`. So a raise is
 * recognised from the rating itself: a `current` rating above what every EARLIER approved
 * version's declared rating, floored at the same media, gives was put there by something other
 * than an approve. Then the result never goes below `current`. `earlierDeclared` holds those
 * declarations (the highest is the one compared), read before this approve overwrites the app's
 * rating. Every earlier version, not only the last: a listing an `x` version rated and a later
 * `pg13` approve left at `x` (before this sync existed) is an approve's rating, not a raise.
 *
 * The test reads the media as it is NOW, so a rating that mature media raised and that stayed
 * after the media was removed (an on-site revision copies assets without re-rating) also reads
 * as a raise and is kept. That errs towards the stricter rating.
 *
 * The floor uses the media split a moderator granted, if any (`readListingMediaSplit`): this
 * approve publishes no listing, so it takes no split decision.
 */
export async function resolveVersionListingRating(
  db: Prisma.TransactionClient,
  args: {
    appListingId: string;
    current: string | null;
    earlierDeclared: (string | null)[];
    nextDeclared: string | null;
  }
): Promise<string | null> {
  const highestEarlier = args.earlierDeclared.reduce<string | null>(
    (top, r) =>
      r != null && nsfwLevelFromContentRating(r) > nsfwLevelFromContentRating(top) ? r : top,
    args.earlierDeclared.find((r) => r != null) ?? null
  );
  const split = await readListingMediaSplit(db, args.appListingId);
  const next = await resolveListingRatingFloorInTx(db, args.appListingId, args.nextDeclared, split);
  const previous = await resolveListingRatingFloorInTx(
    db,
    args.appListingId,
    highestEarlier,
    split
  );
  const currentLevel = nsfwLevelFromContentRating(args.current);
  const raisedByModerator = currentLevel > nsfwLevelFromContentRating(previous);
  return raisedByModerator && currentLevel > nsfwLevelFromContentRating(next) ? args.current : next;
}
