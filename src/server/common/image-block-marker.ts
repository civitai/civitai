// No Prisma imports: profile-picture.servable.ts uses it under suites that mock `@prisma/client`.
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { isOwnerExemptBlock, ownerVisibleBlockedFor } from '~/shared/utils/image-blocked';

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

export { OWNER_MEDIA_EXEMPT_BLOCKS, ownerVisibleBlockedFor } from '~/shared/utils/image-blocked';

/**
 * Whether an image's owner may be served its media: it carries no block, or only an exempt one.
 * For the owner a Blocked level alone is a rating, not a block (`hasBlockMarker` counts it for
 * everyone else).
 */
export function ownerMediaAllowed(image: {
  ingestion: ImageIngestionStatus | string;
  blockedFor: string | null;
}) {
  if (image.blockedFor != null) return isOwnerExemptBlock(image.blockedFor);
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

/**
 * The ingestion signal payload an image's owner receives. A block reason reaches the owner only
 * when it is one they can act on (`OWNER_MEDIA_EXEMPT_BLOCKS`); every other reason is dropped,
 * so the blocked state comes from `ingestion` alone.
 */
export function ownerIngestionSignalData({
  imageId,
  ingestion,
  blockedFor,
  nsfwLevel,
}: {
  imageId: number;
  ingestion: ImageIngestionStatus;
  blockedFor?: string | null;
  nsfwLevel?: number;
}) {
  return {
    imageId,
    ingestion,
    blockedFor: ownerVisibleBlockedFor(blockedFor) ?? undefined,
    nsfwLevel,
  };
}
