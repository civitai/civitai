import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

// The only lock a moderator didn't set: Knights consensus locks through the moderator path.
export const KNIGHTS_VOTE_NSFW_LEVEL_REASON = 'Knights Vote';
const PERMANENT_SCAN_FAILURE = 'permanent';

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

/** The images `minorMatureImageVisibleSql` shows only to their owner and moderators. */
export const isMinorMatureImage = (image: { minor?: boolean | null; nsfwLevel: number }) =>
  image.minor === true && image.nsfwLevel >= NsfwLevel.R;

/**
 * A minor-flagged image rated R or above is shown only to its owner and moderators, whatever the
 * viewer's browsing settings, as SQL over `"<alias>"`. With no viewer it is shown to nobody, so a
 * viewer-independent read (a shared cache, a search document) never carries one.
 */
export const minorMatureImageVisibleSql = (
  viewer: { userId?: number; isModerator?: boolean } = {},
  alias = 'i'
) => {
  if (viewer.isModerator) return Prisma.sql`TRUE`;
  const t = Prisma.raw(`"${alias}"`);
  const ownImage = viewer.userId ? Prisma.sql` OR ${t}."userId" = ${viewer.userId}` : Prisma.empty;
  return Prisma.sql`(${t}."minor" IS NOT TRUE OR ${t}."nsfwLevel" < ${NsfwLevel.R}${ownImage})`;
};
