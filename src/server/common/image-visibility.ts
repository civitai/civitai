import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';

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

/** A song's lyrics csam hold in `TextScanHold`, whose `entityId` is the song's image id. */
export const SONG_LYRICS_HOLD = { entityType: 'TrackLyrics', label: 'csam' } as const;

/** Statuses of a song's lyrics csam hold that keep the song hidden: awaiting a moderator, or confirmed. */
export const LYRICS_HOLD_HIDING_STATUSES = ['Pending', 'Confirmed'] as const;

export const lyricsHeldSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "TextScanHold" h
    WHERE h."entityType" = ${SONG_LYRICS_HOLD.entityType} AND h."entityId" = ${t}."id"
      AND h."label" = ${SONG_LYRICS_HOLD.label}
      AND h."status"::text IN (${Prisma.join([...LYRICS_HOLD_HIDING_STATUSES])})
  )`;
};

/**
 * Scans stall. When one does, the image stays `Pending`/`Error` — even after a mod
 * rates it, because `updateImageNsfwLevel` sets the level but not the ingestion state.
 * A locked rating is a human decision, so it counts as reviewed here in place of a scan
 * that never arrived.
 *
 * A song is the exception: its scan is the only check of what it says, so a locked rating never
 * stands in for it and only `Scanned` counts.
 *
 * `Error` is stricter: a scan that errored never ran its minor/POI/prompt checks, so only
 * a moderator's lock stands in for it, and not when the media itself failed permanently.
 */
export const imageReviewedSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(
    (${t}."type" <> ${MediaType.audio}::"MediaType" OR NOT ${lyricsHeldSql(alias)})
    AND (
    ${t}."ingestion" = ${ImageIngestionStatus.Scanned}::"ImageIngestionStatus"
    OR (
      ${t}."type" <> ${MediaType.audio}::"MediaType"
      AND ${t}."nsfwLevelLocked" = TRUE
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
    )
  )`;
};

/** `imageReviewedSql` for songs alone, for reads that gate images and videos by level only. */
export const songReviewedSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(${t}."type" <> ${MediaType.audio}::"MediaType" OR ${imageReviewedSql(alias)})`;
};

/**
 * What a signed-in non-moderator's `pending` read requires of another user's image, over `Image`
 * aliased `i`: not awaiting moderator review, not `acceptableMinor`, and reviewed if rated. The
 * viewer's own images are exempt. Unrated images still need the read's own level check to show.
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
  type,
  lyricsHeld,
  ingestion,
  nsfwLevelLocked,
  nsfwLevelReason,
  scanFailureClass,
}: {
  type: MediaType | string;
  /** `lyricsHeldSql`: the song's lyrics are held for csam. */
  lyricsHeld: boolean;
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  nsfwLevelReason: string | null | undefined;
  scanFailureClass: string | null | undefined;
}) => {
  if (type === MediaType.audio && lyricsHeld) return false;
  if (ingestion === ImageIngestionStatus.Scanned) return true;
  if (type === MediaType.audio) return false;
  if (!nsfwLevelLocked || ingestionStatesModRatingCannotOverride.includes(ingestion)) return false;
  if (ingestion !== ImageIngestionStatus.Error) return true;
  return (
    nsfwLevelReason !== KNIGHTS_VOTE_NSFW_LEVEL_REASON &&
    scanFailureClass !== PERMANENT_SCAN_FAILURE
  );
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
