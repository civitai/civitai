// No Prisma imports: profile-picture.servable.ts uses it under suites that mock `@prisma/client`.
import { NsfwLevel } from '~/server/common/enums';
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
