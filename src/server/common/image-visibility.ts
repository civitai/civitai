import { Prisma } from '@prisma/client';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// The only lock a moderator didn't set: Knights consensus locks through the moderator path.
export const KNIGHTS_VOTE_NSFW_LEVEL_REASON = 'Knights Vote';
const PERMANENT_SCAN_FAILURE = 'permanent';

// Blocked is a ToS removal; NotFound has no media behind the row.
const ingestionStatesModRatingCannotOverride: ImageIngestionStatus[] = [
  ImageIngestionStatus.Blocked,
  ImageIngestionStatus.NotFound,
];

/**
 * Scans stall. When one does, the image stays `Pending`/`Error` — even after a mod
 * rates it, because `updateImageNsfwLevel` sets the level but not the ingestion state.
 * A locked rating is a human decision, so it counts as reviewed here in place of a scan
 * that never arrived.
 *
 * `Error` is stricter: a scan that errored never ran its minor/POI/prompt checks, so only
 * a moderator's lock stands in for it, and not when the media itself failed permanently.
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
      AND NOT (
        ${t}."ingestion" = ${ImageIngestionStatus.Error}::"ImageIngestionStatus"
        AND (
          COALESCE(${t}."metadata"->>'nsfwLevelReason', '') = ${KNIGHTS_VOTE_NSFW_LEVEL_REASON}
          OR COALESCE(${t}."scanJobs"->'error'->>'failureClass', '') = ${PERMANENT_SCAN_FAILURE}
        )
      )
    )
  )`;
};

/**
 * TS twin of `imageReviewedSql`, for rows already fetched. Kept next to it
 * deliberately: the rule is one decision with two encodings, and they have to
 * move together.
 */
export const isImageReviewed = ({
  ingestion,
  nsfwLevelLocked,
  nsfwLevelReason,
  scanFailureClass,
}: {
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  nsfwLevelReason: string | null | undefined;
  scanFailureClass: string | null | undefined;
}) => {
  if (ingestion === ImageIngestionStatus.Scanned) return true;
  if (!nsfwLevelLocked || ingestionStatesModRatingCannotOverride.includes(ingestion)) return false;
  if (ingestion !== ImageIngestionStatus.Error) return true;
  return (
    nsfwLevelReason !== KNIGHTS_VOTE_NSFW_LEVEL_REASON &&
    scanFailureClass !== PERMANENT_SCAN_FAILURE
  );
};
