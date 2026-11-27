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
 * For the owner a Blocked level alone is a rating, not a block (`hasBlockMarker` counts it for
 * everyone else).
 */
export function ownerMediaAllowed(image: {
  ingestion: ImageIngestionStatus | string;
  blockedFor: string | null;
}) {
  if (image.blockedFor != null) return OWNER_MEDIA_EXEMPT_BLOCKS.includes(image.blockedFor);
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

/** The block reason an image's owner may see: only one they can act on (`OWNER_MEDIA_EXEMPT_BLOCKS`). */
export function ownerVisibleBlockedFor(blockedFor?: string | null): string | null {
  return blockedFor != null && OWNER_MEDIA_EXEMPT_BLOCKS.includes(blockedFor) ? blockedFor : null;
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
