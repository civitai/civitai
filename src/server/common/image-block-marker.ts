// No Prisma imports: profile-picture.servable.ts uses it under suites that mock `@prisma/client`.
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

/**
 * Whether an image carries a block. A scan error or a rescan request moves `ingestion` off
 * Blocked but leaves the block reason and the Blocked level, so any one of the three counts.
 */
export function hasBlockMarker(image: {
  ingestion: ImageIngestionStatus | string;
  nsfwLevel: number;
  blockedFor: string | null;
}) {
  return (
    image.ingestion === ImageIngestionStatus.Blocked ||
    image.nsfwLevel === NsfwLevel.Blocked ||
    image.blockedFor != null
  );
}

/**
 * The block reasons that leave an image's media with its owner: a hold the owner clears by adding
 * metadata, not a safety block. An allow-list, so any other reason, including one added later,
 * refuses the owner the media.
 */
export const OWNER_MEDIA_EXEMPT_BLOCKS: readonly string[] = [BlockedReason.AiNotVerified];

/**
 * The block reasons that, with `reviewedBlocks` (the `ownerBlockedMedia` flag), also leave an image's
 * media with its owner, alone or listed together, while the image carries no CSAM mark
 * (`ownerCsamMarkedSql`). An allow-list: any other reason in the list withholds.
 */
export const OWNER_MEDIA_REVIEWED_BLOCKS: readonly string[] = [
  BlockedReason.Moderated,
  BlockedReason.TOS,
];

/**
 * Whether every reason in a comma list of block reasons is in `OWNER_MEDIA_REVIEWED_BLOCKS`. Trims
 * spaces only, as the SQL twin's `btrim` does.
 */
export const isReviewedBlock = (blockedFor: string) =>
  blockedFor
    .split(',')
    .every((reason) => OWNER_MEDIA_REVIEWED_BLOCKS.includes(reason.replace(/^ +| +$/g, '')));

/**
 * Whether an image's owner may be served its media: it carries no block, or only an exempt one, or
 * with `reviewedBlocks` a reviewed one (`isReviewedBlock`) on an image whose scan ended Blocked and
 * where `ownerCsamMarked` was read as false (unread, it withholds). For the owner a Blocked level
 * alone is a rating, not a block (`hasBlockMarker` counts it for everyone else).
 */
export function ownerMediaAllowed(
  image: {
    ingestion: ImageIngestionStatus | string;
    blockedFor: string | null;
    /** `ownerCsamMarkedSql` for the image, read only where `reviewedBlocks` is on. */
    ownerCsamMarked?: boolean | null;
  },
  { reviewedBlocks = false }: { reviewedBlocks?: boolean } = {}
) {
  if (image.blockedFor != null)
    return (
      OWNER_MEDIA_EXEMPT_BLOCKS.includes(image.blockedFor) ||
      (reviewedBlocks &&
        image.ingestion === ImageIngestionStatus.Blocked &&
        image.ownerCsamMarked === false &&
        isReviewedBlock(image.blockedFor))
    );
  return image.ingestion !== ImageIngestionStatus.Blocked;
}

/**
 * Whether a block leaves `viewerId` an image's media: a moderator keeps it, its owner per
 * `ownerMediaAllowed`, anyone else only when the image carries no block.
 */
export function blockLeavesMedia(
  image: {
    userId: number;
    ingestion: ImageIngestionStatus | string;
    nsfwLevel: number;
    blockedFor: string | null;
  },
  viewerId?: number | null,
  actsAsModerator = false
) {
  if (actsAsModerator) return true;
  if (viewerId != null && image.userId === viewerId) return ownerMediaAllowed(image);
  return !hasBlockMarker(image);
}
