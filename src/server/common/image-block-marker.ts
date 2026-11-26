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
 * Whether an image's owner may be served its media: it carries no block, or only an exempt one.
 * A Blocked rating with no block reason and no Blocked ingestion is a rating, not a block.
 * `ownerMediaAllowedSql` is its SQL twin.
 */
export function ownerMediaAllowed(image: {
  ingestion: ImageIngestionStatus | string;
  blockedFor: string | null;
}) {
  if (image.blockedFor != null) return OWNER_MEDIA_EXEMPT_BLOCKS.includes(image.blockedFor);
  return image.ingestion !== ImageIngestionStatus.Blocked;
}
