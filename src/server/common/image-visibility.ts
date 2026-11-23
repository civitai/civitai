import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import { Prisma } from '@prisma/client';
import { NsfwLevel } from '~/server/common/enums';
import { ImageScanFailureClass } from '~/server/services/image-scan-failure';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability, ImageIngestionStatus, MediaType } from '~/shared/utils/prisma/enums';
import { isRestrictedImage } from '~/shared/utils/restricted-image';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { REVIEWS_KEPT_WHEN_LIFTED } from '@civitai/shared/image-review-types';
import { LIFT_WHILE_OWNER_DELETED } from '@civitai/shared/account-deletion-grace';
import { isMinorContentRestricted } from '@civitai/shared/minor-content-gate';
import {
  minorContentNotRestrictedWhere,
  minorContentRestrictedSql,
} from '~/server/utils/minor-content-gate.sql';
import { OWNER_HIDDEN_REVIEWS, isHeldForReview } from '~/server/common/owner-hidden-reviews';
import { hasBlockMarker } from '~/server/common/image-block-marker';
import {
  PRIOR_BLOCKED_FOR_KEY,
  PRIOR_INGESTION_KEY,
  PRIOR_NEEDS_REVIEW_KEY,
} from '~/server/utils/image-removal-mode';

export { KNIGHTS_VOTE_NSFW_LEVEL_REASON, isHeldForReview, hasBlockMarker };
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
          OR ${permanentScanFailureSql(t)}
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
 * Not under an owner-hidden review hold, or uploaded by `ownerId` (the session user: never an id
 * from input). `needsReview` is nullable: `notIn` alone would drop every unflagged image.
 */
export const notHeldForReviewWhere = (ownerId?: number | null): Prisma.ImageWhereInput => ({
  OR: [
    { needsReview: null },
    { needsReview: { notIn: OWNER_HIDDEN_REVIEWS } },
    ...(isUploaderId(ownerId) ? [{ userId: ownerId }] : []),
  ],
});

/** `notHeldForReviewWhere` as SQL over `Image` aliased `i`. */
export const notHeldForReviewSql = (ownerId?: number | null) =>
  Prisma.sql`(i."needsReview" IS NULL OR i."needsReview" NOT IN (${Prisma.join(
    OWNER_HIDDEN_REVIEWS
  )})${isUploaderId(ownerId) ? Prisma.sql` OR i."userId" = ${ownerId}` : Prisma.empty})`;

/** `servableLevelWhere` as SQL over `Image` aliased `i`. */
export const servableLevelSql = (levels: number) =>
  levels === allBrowsingLevelsFlag
    ? Prisma.sql`TRUE`
    : Prisma.sql`i."nsfwLevel" IN (${Prisma.join(Flags.instanceToArray(levels))})`;

/** TS twin of `servableLevelWhere`, for one image's level. */
export const isServableLevel = (nsfwLevel: number, levels: number) =>
  levels === allBrowsingLevelsFlag || Flags.instanceToArray(levels).includes(nsfwLevel);

/** TS twin of `servableLevelOrOwnUnratedWhere`, for one image. */
export const isServableLevelOrOwnUnrated = (
  image: { nsfwLevel: number; userId: number },
  levels: number,
  viewerId: number
) =>
  isServableLevel(image.nsfwLevel, levels) || (image.nsfwLevel === 0 && image.userId === viewerId);

/** Held to the request's servable levels: a capped request gets no unrated upload either. */
export const servableLevelWhere = (levels: number): Prisma.ImageWhereInput =>
  levels === allBrowsingLevelsFlag ? {} : { nsfwLevel: { in: Flags.instanceToArray(levels) } };

/**
 * `servableLevelWhere`, but `userId`'s own unrated uploads stay in, so an owner keeps sight of an
 * upload while its scan runs. Not an `OR` around `servableLevelWhere`: with its uncapped `{}`
 * inside, Prisma's `OR` returned no rows.
 */
export const servableLevelOrOwnUnratedWhere = (
  levels: number,
  userId: number
): Prisma.ImageWhereInput =>
  levels === allBrowsingLevelsFlag
    ? {}
    : { OR: [{ nsfwLevel: { in: Flags.instanceToArray(levels) } }, { userId, nsfwLevel: 0 }] };

type RestrictedImageOptions = { alias?: string; viewerId?: number | null };

/**
 * Over `Image` aliased `alias`: false for a mature image made with a base model that restricts
 * mature images (`modelRestricted`), unless `viewerId` uploaded it. Moderators get no exception.
 * Pass `viewerId` only where the result is per viewer, never into a cache shared between viewers.
 */
export const imageNotRestrictedSql = ({ alias = 'i', viewerId }: RestrictedImageOptions = {}) => {
  const t = Prisma.raw(alias);
  const own = isUploaderId(viewerId) ? Prisma.sql` OR ${t}."userId" = ${viewerId}` : Prisma.empty;
  return Prisma.sql`((${t}."nsfwLevel" & ${nsfwBrowsingLevelsFlag}) = 0 OR NOT ${t}."modelRestricted"${own})`;
};

// Non-positive ids are placeholders (system accounts), never a real uploader.
export const isUploaderId = (viewerId?: number | null): viewerId is number =>
  !!viewerId && viewerId > 0;

/**
 * `imageNotRestrictedSql` as a Prisma `Image` filter. `nsfwLevel` holds a single level, so
 * `notIn` the mature levels matches the SQL's bitmask test.
 */
export const imageNotRestrictedWhere = ({
  viewerId,
}: { viewerId?: number | null } = {}): Prisma.ImageWhereInput => ({
  OR: [
    { nsfwLevel: { notIn: nsfwBrowsingLevelsArray } },
    { modelRestricted: false },
    ...(isUploaderId(viewerId) ? [{ userId: viewerId }] : []),
  ],
});

/**
 * Neither acceptable-minor nor held back by the minor content rule, as a Prisma filter: what a
 * signed-out viewer may be shown on those two counts. `isImageNotFlagged` is its TS twin.
 */
export const imageNotFlaggedWhere = () =>
  ({
    acceptableMinor: false,
    AND: [minorContentNotRestrictedWhere()],
  } satisfies Prisma.ImageWhereInput);

// Ratings a cover may never carry.
const COVER_EXCLUDED_LEVELS = [0, NsfwLevel.Blocked];

/**
 * How a cover treats a minor-flagged image. `strict` refuses every one (public collection covers);
 * `minorContent` refuses one only where the minor content rule restricts it (challenge covers).
 */
export type CoverMinorRule = 'strict' | 'minorContent';

type CoverCoreImage = {
  needsReview: string | null;
  tosViolation: boolean;
  acceptableMinor: boolean;
  minor: boolean | null;
  nsfwLevel: number | null;
};

/**
 * The checks every cover passes, whoever is shown it. `coverCoreSql` and `isCoverCore` are its
 * twins: change all three together.
 */
export const coverCoreWhere = (minor: CoverMinorRule): Prisma.ImageWhereInput[] => [
  { needsReview: null },
  { tosViolation: false },
  { acceptableMinor: false },
  { nsfwLevel: { notIn: COVER_EXCLUDED_LEVELS } },
  minor === 'strict' ? { minor: false } : minorContentNotRestrictedWhere(),
];

/** `coverCoreWhere` as SQL over `"Image" i`. */
export const coverCoreSql = (minor: CoverMinorRule) => Prisma.sql`(
  i."needsReview" IS NULL
  AND i."tosViolation" = FALSE
  AND i."acceptableMinor" = FALSE
  AND i."nsfwLevel" NOT IN (${Prisma.join(COVER_EXCLUDED_LEVELS)})
  AND ${
    minor === 'strict'
      ? Prisma.sql`i."minor" = FALSE`
      : Prisma.sql`NOT ${minorContentRestrictedSql({
          minor: Prisma.sql`COALESCE(i."minor", FALSE)`,
          nsfwLevel: Prisma.sql`i."nsfwLevel"`,
        })}`
  }
)`;

/** `coverCoreWhere` over an image already read. */
export const isCoverCore = (image: CoverCoreImage, minor: CoverMinorRule) =>
  image.needsReview === null &&
  image.tosViolation === false &&
  image.acceptableMinor === false &&
  // An unrated (NULL) level fails, as NOT IN does in SQL.
  image.nsfwLevel != null &&
  !COVER_EXCLUDED_LEVELS.includes(image.nsfwLevel) &&
  (minor === 'strict'
    ? image.minor === false
    : !isMinorMatureImage({ minor: image.minor, nsfwLevel: image.nsfwLevel }));

/** A challenge cover any viewer may be shown. `challengeCoverSql` is its SQL twin: change both together. */
export const challengeCoverWhere = (): Prisma.ImageWhereInput => ({
  AND: [
    ...coverCoreWhere('minorContent'),
    {
      OR: [
        { postId: null },
        {
          post: {
            publishedAt: { lt: new Date() },
            availability: { not: Availability.Private },
          },
        },
      ],
    },
  ],
});

/** `challengeCoverWhere` as SQL over `"Image" i`. */
export const challengeCoverSql = () => Prisma.sql`(
  ${coverCoreSql('minorContent')}
  AND (i."postId" IS NULL OR EXISTS (
    SELECT 1 FROM "Post" cp
    WHERE cp.id = i."postId"
      AND cp."publishedAt" < now()
      AND cp.availability != ${Availability.Private}::"Availability"
  ))
)`;

/** What {@link isImageNotRestricted} reads from an `Image`. */
export const imageRestrictionSelect = {
  nsfwLevel: true,
  modelRestricted: true,
  userId: true,
} as const;

export type RestrictableImage = Pick<Selectable<DB['Image']>, keyof typeof imageRestrictionSelect>;

/** TS twin of `imageNotRestrictedSql`, for rows already fetched. */
export const isImageNotRestricted = (image: RestrictableImage, viewerId?: number | null) =>
  !isRestrictedImage(image) || (isUploaderId(viewerId) && image.userId === viewerId);

/** Whether `viewerId` may see `image`: not restricted, and not rated Blocked, unless they uploaded it. */
export const isImageServable = (image: RestrictableImage, viewerId?: number | null) =>
  isImageNotRestricted(image, viewerId) &&
  (image.nsfwLevel !== NsfwLevel.Blocked || (isUploaderId(viewerId) && image.userId === viewerId));

/** `row` with its image at `key` set to null when `viewerId` may not see it. */
export function withServableImage<
  K extends PropertyKey,
  T extends { [P in K]: RestrictableImage | null | undefined }
>(row: T, key: K, viewerId?: number | null): T & { [P in K]: T[P] | null } {
  const image = row[key];
  return { ...row, [key]: image && isImageServable(image, viewerId) ? image : null };
}

/** The exact complement of `imageNotRestrictedSql`: a NULL flag on a mature image counts as restricted. */
export const imageRestrictedSql = (options: RestrictedImageOptions = {}) =>
  Prisma.sql`${imageNotRestrictedSql(options)} IS NOT TRUE`;

/**
 * What a signed-in non-moderator's `pending` read requires of another user's image, over `Image`
 * aliased `i`: not awaiting moderator review, not `acceptableMinor`, and reviewed if rated. The
 * viewer's own images are exempt; those under an owner-hidden review hold only with `ownerSeesHeld`.
 * Unrated images still need the read's own level check to show.
 * `acceptableMinorAlso` admits further images past the `acceptableMinor` check only.
 */
export const pendingOthersImageConditions = (
  userId: number,
  {
    acceptableMinorAlso,
    ownerSeesHeld = false,
  }: {
    acceptableMinorAlso?: Prisma.Sql;
    /** Lift the hold for `userId` too: only when the request carries the owner's view (`credentialViews`). */
    ownerSeesHeld?: boolean;
  } = {}
) => [
  Prisma.sql`(i."needsReview" IS NULL OR i."userId" = ${userId})`,
  Prisma.sql`(i."acceptableMinor" = FALSE OR i."userId" = ${userId}${
    acceptableMinorAlso ? Prisma.sql` OR ${acceptableMinorAlso}` : Prisma.empty
  })`,
  Prisma.sql`(i."userId" = ${userId} OR i."nsfwLevel" = 0 OR ${imageReviewedSql()})`,
  notHeldForReviewSql(ownerSeesHeld ? userId : undefined),
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
  scanJobs,
}: {
  type: MediaType | string;
  /** `lyricsHeldSql`: the song's lyrics are held for csam. */
  lyricsHeld: boolean;
  ingestion: ImageIngestionStatus;
  nsfwLevelLocked: boolean;
  nsfwLevelReason: string | null | undefined;
  scanJobs: unknown;
}) => {
  if (type === MediaType.audio && lyricsHeld) return false;
  if (ingestion === ImageIngestionStatus.Scanned) return true;
  if (type === MediaType.audio) return false;
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
 * The row still holds an account-deletion grace block, which `unblockAccountDeletionImages` reverts
 * on restore. A write that would lift it leaves the row alone; a write that lands strips the
 * breadcrumbs (`withoutGraceMarkersSql`), so a restore leaves what it wrote in place.
 */
export const graceBlockedSql = Prisma.sql`("ingestion" = 'Blocked'::"ImageIngestionStatus"
  AND ("metadata" -> ${PRIOR_INGESTION_KEY}::text) IS NOT NULL)`;

/**
 * `needsReview` for a row a moderator lifts (an unblock or an approved appeal): the review an
 * account-deletion grace block recorded, when lifting does not settle it, else none.
 */
export const reviewKeptWhenLiftedSql = Prisma.sql`(CASE
  WHEN "metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text = ANY(${REVIEWS_KEPT_WHEN_LIFTED}::text[])
  THEN "metadata"->>${PRIOR_NEEDS_REVIEW_KEY}::text
END)`;

/** `metadata` without the grace-block breadcrumbs. A non-object value is left as it is. */
export const withoutGraceMarkersSql = (metadata: Prisma.Sql = Prisma.sql`"metadata"`) =>
  Prisma.sql`(CASE WHEN jsonb_typeof(${metadata}) = 'object'
    THEN (${metadata}) - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text - ${PRIOR_NEEDS_REVIEW_KEY}::text
    ELSE ${metadata} END)`;

/** The image's owner has deleted their account (in its grace period, or not yet purged). */
export const ownerDeletedSql = Prisma.sql`EXISTS (SELECT 1 FROM "User" u WHERE u.id = "Image"."userId" AND u."deletedAt" IS NOT NULL)`;

// A lift (approved appeal, unblock) while the owner is deleted keeps the row blocked and records the
// lifted state for an account restore: LIFT_WHILE_OWNER_DELETED. Twin: OWNER_DELETED and the LIFTED_*
// fragments in apps/moderator/src/lib/server/image-moderation.service.ts.
const { keeps: KEPT, records: RECORDED } = LIFT_WHILE_OWNER_DELETED;

/** `needsReview` for a lifted row: none while it stays blocked, else the review a lift keeps. */
export const liftedNeedsReviewSql = Prisma.sql`(CASE WHEN ${ownerDeletedSql} THEN NULL ELSE ${reviewKeptWhenLiftedSql} END)`;
/** `blockedFor` for a lifted row. */
export const liftedBlockedForSql = Prisma.sql`(CASE WHEN ${ownerDeletedSql} THEN ${KEPT.blockedFor}::text END)`;
/** `ingestion` for a lifted row. */
export const liftedIngestionSql = Prisma.sql`(CASE WHEN ${ownerDeletedSql} THEN ${KEPT.ingestion} ELSE ${RECORDED.ingestion} END)::"ImageIngestionStatus"`;
/** `nsfwLevel` for a lifted row: Blocked while it stays blocked, as the grace block sets it. */
export const liftedNsfwLevelSql = Prisma.sql`(CASE WHEN ${ownerDeletedSql} THEN ${KEPT.nsfwLevel}::int ELSE "nsfwLevel" END)`;
/** For RETURNING: the lifted row stayed blocked because its owner is deleted. */
export const liftKeptBlockedSql = Prisma.sql`(ingestion = ${KEPT.ingestion}::"ImageIngestionStatus")`;

/** `metadata` for a lifted row: the breadcrumbs off, or while the owner is deleted, recording the lift. */
export function liftedUnderGraceSql(stripped: Prisma.Sql) {
  return Prisma.sql`(CASE WHEN ${ownerDeletedSql}
  THEN COALESCE(${stripped}, '{}'::jsonb) || jsonb_build_object(
    ${PRIOR_INGESTION_KEY}::text, ${RECORDED.ingestion}::text, ${PRIOR_BLOCKED_FOR_KEY}::text, ${RECORDED.blockedFor}::text,
    ${PRIOR_NEEDS_REVIEW_KEY}::text, ${reviewKeptWhenLiftedSql})
  ELSE ${stripped} END)`;
}

/** `metadata` for an approved appeal. */
export const liftedMetadataSql = liftedUnderGraceSql(withoutGraceMarkersSql());

/** `metadata` for an unblock: also drops the rule keys; while the owner is deleted, `liftedUnderGraceSql` records the lift for the account restore. */
export const unblockedMetadataSql = liftedUnderGraceSql(
  Prisma.sql`"metadata" - 'ruleId' - 'ruleReason' - ${PRIOR_INGESTION_KEY}::text - ${PRIOR_BLOCKED_FOR_KEY}::text - ${PRIOR_NEEDS_REVIEW_KEY}::text`
);

export const ingestionAfterScanErrorSql = () => Prisma.sql`(CASE
  WHEN "ingestion" = 'NotFound'::"ImageIngestionStatus" OR ${graceBlockedSql} THEN "ingestion"
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
/** The image without its `minor` flag, read only to apply the rule below and never sent on. */
export const withoutMinorFlag = <T extends { minor?: boolean | null }>({
  minor: _minor,
  ...image
}: T) => image;

/** The images `minorMatureImageVisibleSql` shows only to their owner and moderators. */
export const isMinorMatureImage = (image: { minor?: boolean | null; nsfwLevel: number }) =>
  isMinorContentRestricted({ minor: image.minor === true, nsfwLevel: image.nsfwLevel });

/**
 * A minor-flagged image the minor content rule restricts is shown only to its owner and
 * moderators, whatever the viewer's browsing settings, as SQL over `"Image" i`. With no viewer it
 * is shown to nobody, so a viewer-independent read (a shared cache, a search document) never
 * carries one.
 */
export const minorMatureImageVisibleSql = (
  viewer: { userId?: number; isModerator?: boolean } = {}
) => {
  if (viewer.isModerator) return Prisma.sql`TRUE`;
  const ownImage = viewer.userId ? Prisma.sql` OR i."userId" = ${viewer.userId}` : Prisma.empty;
  const restricted = minorContentRestrictedSql({
    minor: Prisma.sql`COALESCE(i."minor", FALSE)`,
    nsfwLevel: Prisma.sql`i."nsfwLevel"`,
  });
  return Prisma.sql`(NOT ${restricted}${ownImage})`;
};

/** `imageNotFlaggedWhere` over an image already read. */
export const isImageNotFlagged = (image: {
  acceptableMinor: boolean;
  minor: boolean | null;
  nsfwLevel: number;
}) => !image.acceptableMinor && !isMinorMatureImage(image);
