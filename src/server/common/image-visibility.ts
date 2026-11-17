import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { ImageScanFailureClass } from '~/server/services/image-scan-failure';
import { allBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';

export { KNIGHTS_VOTE_NSFW_LEVEL_REASON };
const PERMANENT_SCAN_FAILURE = ImageScanFailureClass.Permanent;

/**
 * Whether a scan's media failed permanently. A re-submit moves `scanJobs.error` to
 * `scanJobs.lastFailure` and a later error lands beside it, so either can carry the class;
 * `scanJobs.permanentFailure` keeps it once a later write would drop or replace both.
 */
const permanentScanFailureSql = (t: Prisma.Sql) => Prisma.sql`(
  COALESCE(${t}."scanJobs"->'error'->>'failureClass', '') = ${PERMANENT_SCAN_FAILURE}
  OR COALESCE(${t}."scanJobs"->'lastFailure'->>'failureClass', '') = ${PERMANENT_SCAN_FAILURE}
  OR COALESCE(${t}."scanJobs"->'permanentFailure' = 'true'::jsonb, FALSE)
)`;

/**
 * `{"permanentFailure": true}` when an `Image` row's `scanJobs` shows a permanent failure, else
 * `{}`. Append it in every UPDATE that writes, drops or replaces `error` / `lastFailure`.
 */
export const keepPermanentScanFailureSql = () => Prisma.sql`(CASE
  WHEN ${permanentScanFailureSql(Prisma.raw('"Image"'))}
  THEN '{"permanentFailure": true}'::jsonb
  ELSE '{}'::jsonb
END)`;

/** TS twin of `permanentScanFailureSql`, over an image's `scanJobs` value. */
export const hasPermanentScanFailure = (scanJobs: unknown) => {
  if (!scanJobs || typeof scanJobs !== 'object') return false;
  const { error, lastFailure, permanentFailure } = scanJobs as {
    error?: unknown;
    lastFailure?: unknown;
    permanentFailure?: unknown;
  };
  return (
    permanentFailure === true ||
    [error, lastFailure].some(
      (failure) =>
        !!failure &&
        typeof failure === 'object' &&
        (failure as { failureClass?: unknown }).failureClass === PERMANENT_SCAN_FAILURE
    )
  );
};

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

/** SQL twin of `hasBlockMarker`: the two encodings of one rule move together. */
export const hasBlockMarkerSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(
    ${t}."ingestion" = ${ImageIngestionStatus.Blocked}::"ImageIngestionStatus"
    OR ${t}."nsfwLevel" = ${NsfwLevel.Blocked}
    OR ${t}."blockedFor" IS NOT NULL
  )`;
};

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
          OR ${permanentScanFailureSql(t)}
        )
      )
    )
  )`;
};

/** Review holds not served even to the image's owner; their other review states stay visible to them. */
const OWNER_HIDDEN_REVIEWS = ['csam', 'minor'];

/** Not under an owner-hidden review hold. `needsReview` is nullable: `notIn` alone would drop every unflagged image. */
export const notHeldForReviewWhere = (): Prisma.ImageWhereInput => ({
  OR: [{ needsReview: null }, { needsReview: { notIn: OWNER_HIDDEN_REVIEWS } }],
});

/** `notHeldForReviewWhere` as SQL over `Image` aliased `i`. */
export const notHeldForReviewSql = () =>
  Prisma.sql`(i."needsReview" IS NULL OR i."needsReview" NOT IN (${Prisma.join(
    OWNER_HIDDEN_REVIEWS
  )}))`;

/** Held to the request's servable levels: a capped request gets no unrated upload either. */
export const servableLevelWhere = (levels: number): Prisma.ImageWhereInput =>
  levels === allBrowsingLevelsFlag ? {} : { nsfwLevel: { in: Flags.instanceToArray(levels) } };

/**
 * What a signed-in non-moderator's `pending` read requires of another user's image, over `Image`
 * aliased `i`: not awaiting moderator review, not `acceptableMinor`, and reviewed if rated. The
 * viewer's own images are exempt, but for owner-hidden review holds (`notHeldForReviewSql`).
 * Unrated images still need the read's own level check to show.
 * `acceptableMinorAlso` admits further images past the `acceptableMinor` check only.
 */
export const pendingOthersImageConditions = (
  userId: number,
  { acceptableMinorAlso }: { acceptableMinorAlso?: Prisma.Sql } = {}
) => [
  Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`,
  Prisma.sql`(i."acceptableMinor" = FALSE OR i."userId" = ${userId}${
    acceptableMinorAlso ? Prisma.sql` OR ${acceptableMinorAlso}` : Prisma.empty
  })`,
  Prisma.sql`(i."userId" = ${userId} OR i."nsfwLevel" = 0 OR ${imageReviewedSql()})`,
  notHeldForReviewSql(),
];

/**
 * The level check a signed-in non-moderator's `pending` read applies alongside
 * `pendingOthersImageConditions`, over `Image` aliased `i`: rated within `browsingLevel`, or unrated
 * and the viewer's own.
 */
export const pendingLevelImageSql = (userId: number, browsingLevel: number) =>
  Prisma.sql`((i."nsfwLevel" & ${browsingLevel}) != 0 OR (i."nsfwLevel" = 0 AND i."userId" = ${userId}))`;

/**
 * TS twin of `imageReviewedSql`, for rows already fetched. Kept next to it
 * deliberately: the rule is one decision with two encodings, and they have to
 * move together.
 */
export const isImageReviewed = ({
  ingestion,
  nsfwLevelLocked,
  nsfwLevelReason,
  scanJobs,
}: {
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  nsfwLevelReason: string | null | undefined;
  scanJobs: unknown;
}) => {
  if (ingestion === ImageIngestionStatus.Scanned) return true;
  if (!nsfwLevelLocked || ingestionStatesModRatingCannotOverride.includes(ingestion)) return false;
  if (ingestion !== ImageIngestionStatus.Error) return true;
  return nsfwLevelReason !== KNIGHTS_VOTE_NSFW_LEVEL_REASON && !hasPermanentScanFailure(scanJobs);
};

/**
 * The `ingestion` a scan verdict writes. A row that reads NotFound keeps it when the verdict is
 * Scanned: a hidden image (its original is gone) must not be republished by a stale clean result.
 * A requested rescan moves the row to Rescan/Pending first, so its result is unaffected, and a
 * Blocked verdict still lands.
 */
export const ingestionAfterVerdictSql = (verdict: string) => Prisma.sql`(CASE
  WHEN "ingestion" = 'NotFound'::"ImageIngestionStatus"
    AND ${verdict}::"ImageIngestionStatus" = 'Scanned'::"ImageIngestionStatus"
  THEN "ingestion"
  ELSE ${verdict}::"ImageIngestionStatus"
END)`;

/**
 * The `ingestion` a failed scan writes: Error, except that a NotFound image stays NotFound. An Error
 * row with a locked rating counts as reviewed (`imageReviewedSql`) and the retry cron re-sends it,
 * so a failure result would republish a hidden image.
 */
export const ingestionAfterScanErrorSql = () => Prisma.sql`(CASE
  WHEN "ingestion" = 'NotFound'::"ImageIngestionStatus" THEN "ingestion"
  ELSE ${ImageIngestionStatus.Error}::"ImageIngestionStatus"
END)`;

/** The state `ingestionAfterVerdictSql` leaves, for the caller that reports it onward. */
export const ingestionKeptAfterVerdict = (
  current: ImageIngestionStatus | string,
  verdict: ImageIngestionStatus
) =>
  current === ImageIngestionStatus.NotFound && verdict === ImageIngestionStatus.Scanned
    ? ImageIngestionStatus.NotFound
    : verdict;
