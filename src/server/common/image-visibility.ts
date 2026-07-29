import { Prisma } from '@prisma/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// Terminal states a mod rating must never override — Blocked is a ToS removal, and
// Error/NotFound mean there's no usable image behind the row.
const ingestionStatesModRatingCannotOverride: ImageIngestionStatus[] = [
  ImageIngestionStatus.Blocked,
  ImageIngestionStatus.Error,
  ImageIngestionStatus.NotFound,
];

/**
 * Scans stall. When one does, the image keeps `ingestion = 'Pending'` forever and
 * stays invisible to everyone but moderators — even after a mod rates it, because
 * `updateImageNsfwLevel` sets the level but not the ingestion state. A locked rating
 * is a human decision, so it counts as reviewed here in place of a scan that never
 * arrived.
 */
export const imageReviewedSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(
    ${t}."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
    OR (
      ${t}."nsfwLevelLocked" = TRUE
      AND ${t}."ingestion" NOT IN (${Prisma.join(
    ingestionStatesModRatingCannotOverride.map((s) => Prisma.sql`${s}::"ImageIngestionStatus"`)
  )})
    )
  )`;
};
