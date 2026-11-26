import type { DB } from '@civitai/db-schema/kysely';
import type { Selectable } from 'kysely';
import { Prisma } from '@prisma/client';
import { BlockedReason, NsfwLevel } from '~/server/common/enums';
import { MODERATOR_TAKEDOWN_ACTIVITIES } from '~/server/common/moderator-takedown-activities';
import {
  IMAGE_RESCAN_RETRY_LIMIT,
  ImageScanFailureClass,
} from '~/server/services/image-scan-failure';
import {
  allBrowsingLevelsFlag,
  nsfwBrowsingLevelsArray,
  nsfwBrowsingLevelsFlag,
} from '~/shared/constants/browsingLevel.constants';
import { Flags } from '~/shared/utils/flags';
import { Availability, ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import { isRestrictedImage } from '~/shared/utils/restricted-image';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import {
  IMAGE_REVIEW_PRECEDENCE,
  REVIEWS_KEPT_WHEN_LIFTED,
} from '@civitai/shared/image-review-types';
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
  PRIOR_NSFW_LEVEL_KEY,
  PRIOR_NSFW_LOCKED_KEY,
  minusPriorKeysSql,
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

/** `NOT hasBlockMarkerSql` as a Prisma `Image` filter. */
export const noBlockMarkerWhere = (): Prisma.ImageWhereInput => ({
  ingestion: { not: ImageIngestionStatus.Blocked },
  nsfwLevel: { not: NsfwLevel.Blocked },
  blockedFor: null,
});

/** The second arm of `scanKeepsRowSql`, never NULL. */
export const scanKeepsByMarkerSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`COALESCE(
    ${hasBlockMarkerSql(alias)} AND (
      ${t}."needsReview" IN ('csam', 'minor', 'appeal')
      OR ${t}."minor"
      OR (${t}."nsfwLevelLocked" AND ${t}."nsfwLevel" = ${NsfwLevel.Blocked})
      OR EXISTS (
        SELECT 1 FROM "ModActivity" ma
        WHERE ma."entityType" = 'image' AND ma."entityId" = ${t}.id
          AND ma.activity = ANY(${[...MODERATOR_TAKEDOWN_ACTIVITIES]}::text[])
      )
    ),
    false
  )`;
};

/** Decides scan writes, CDN access and requeue of unverified images: change them together. */
export const scanKeepsRowSql = (alias = 'i') => {
  const t = Prisma.raw(`"${alias}"`);
  return Prisma.sql`COALESCE(
    (${t}."blockedFor" IS NOT NULL AND ${t}."blockedFor" <> ${BlockedReason.AiNotVerified})
    OR ${scanKeepsByMarkerSql(alias)},
    false
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

/**
 * The row holds a CSAM block. NULL when `blockedFor` is NULL: a filter negates it with `IS NOT TRUE`.
 * A scan's block write, `keepPendingAppealFlags` and an appeal filing never give such a row the
 * 'appeal' review.
 */
export const csamBlockedSql = (alias?: 'i') =>
  Prisma.raw(`${alias ? `"${alias}".` : ''}"blockedFor" = '${BlockedReason.CSAM}'`);

/** The review flag only the CSAM review clears. */
export const CSAM_REVIEW_FLAG = 'csam';
/** An unblock may lift the image: it has no CSAM block and no CSAM review flag. */
export const liftableByUnblock = (image: {
  blockedFor: string | null;
  needsReview: string | null;
}) => image.blockedFor !== BlockedReason.CSAM && image.needsReview !== CSAM_REVIEW_FLAG;
/** `liftableByUnblock` as the unblock statement's own gate. */
export const liftableByUnblockSql = Prisma.sql`("blockedFor" IS DISTINCT FROM ${BlockedReason.CSAM} AND "needsReview" IS DISTINCT FROM ${CSAM_REVIEW_FLAG})`;

/** An appeal on the image whose id is `imageId` is still Pending. */
export const pendingImageAppealSql = (imageId: Prisma.Sql) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Appeal" a
  WHERE a."entityType" = 'Image'::"EntityType"
    AND a."entityId" = ${imageId}
    AND a.status = 'Pending'::"AppealStatus")`;

/**
 * Reviews only a moderator clears, so a scan never replaces one whatever it ranks. Known gaps, both
 * leaving a review a moderator then clears: an appeal approved while a scan is in flight gets
 * 'appeal' back from that scan, and a 'csam' review cleared while a scan is in flight gets 'csam'
 * back from it.
 */
const REVIEWS_ONLY_A_MODERATOR_CLEARS = ['csam', 'appeal'] as const;

/**
 * `needsReview` after a write that sets `key`, by who writes it: 'human' (an unblock, an approved
 * appeal) writes `key`; 'block' (a scan that leaves the row blocked) settles every review but
 * 'csam', keeping 'appeal' when it is stored, being set, or an appeal is pending, unless the row
 * holds a CSAM block; 'verdict' (any other scan) never clears or lowers a review, and replaces a
 * stored key only by one ranked higher, except that a pending appeal's 'appeal' takes any key but
 * 'csam'. Its SQL reads
 * "Image".id, so it is only for an UPDATE of "Image". `csamBlock` is whether the row holds a CSAM
 * block once the write lands; it defaults to the stored one.
 */
export function reviewKeyAfterSql(
  actor: 'verdict' | 'block' | 'human',
  key: string | null | Prisma.Sql,
  csamBlock: Prisma.Sql = csamBlockedSql()
) {
  const next =
    typeof key === 'string' || key === null ? Prisma.sql`${key}::text` : Prisma.sql`(${key})::text`;
  if (actor === 'human') return next;
  if (actor === 'block')
    // A stored 'appeal' and a Pending appeal are read at write time, so an appeal filed while the
    // scan ran keeps its flag.
    return Prisma.sql`(CASE WHEN "needsReview" = 'csam' THEN "needsReview"
      WHEN ${csamBlock} THEN NULL
      WHEN ${next} = 'appeal' OR "needsReview" = 'appeal' OR ${pendingImageAppealSql(
      Prisma.sql`"Image".id`
    )} THEN 'appeal' END)`;
  return Prisma.sql`(CASE
    WHEN "needsReview" = 'csam' THEN "needsReview"
    WHEN ${next} = 'appeal' THEN ${next}
    WHEN "needsReview" IS NULL THEN ${next}
    WHEN "needsReview" = ANY(${REVIEWS_ONLY_A_MODERATOR_CLEARS}::text[]) THEN "needsReview"
    WHEN array_position(${IMAGE_REVIEW_PRECEDENCE}::text[], ${next})
      < array_position(${IMAGE_REVIEW_PRECEDENCE}::text[], "needsReview") THEN ${next}
    ELSE "needsReview"
  END)`;
}

/** `metadata` without the grace-block breadcrumbs. A non-object value is left as it is. */
export const withoutGraceMarkersSql = (metadata: Prisma.Sql = Prisma.sql`"metadata"`) =>
  Prisma.sql`(CASE WHEN jsonb_typeof(${metadata}) = 'object'
    THEN (${metadata})${minusPriorKeysSql}
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

/** A recorded rating other than Blocked outlives a lift, so a restore still puts back a moderator's lock. */
const ratingKeptWhenLiftedSql = Prisma.sql`(CASE
  WHEN jsonb_typeof("metadata"->${PRIOR_NSFW_LEVEL_KEY}::text) = 'number'
    AND "metadata"->>${PRIOR_NSFW_LEVEL_KEY}::text <> ${String(KEPT.nsfwLevel)}
  THEN jsonb_build_object(${PRIOR_NSFW_LEVEL_KEY}::text, "metadata"->${PRIOR_NSFW_LEVEL_KEY}::text,
    ${PRIOR_NSFW_LOCKED_KEY}::text, "metadata"->${PRIOR_NSFW_LOCKED_KEY}::text)
  ELSE '{}'::jsonb END)`;

/** `metadata` for a lifted row: the breadcrumbs off, or while the owner is deleted, recording the lift. */
export function liftedUnderGraceSql(stripped: Prisma.Sql) {
  return Prisma.sql`(CASE WHEN ${ownerDeletedSql}
  THEN COALESCE(${stripped}, '{}'::jsonb) || jsonb_build_object(
    ${PRIOR_INGESTION_KEY}::text, ${RECORDED.ingestion}::text, ${PRIOR_BLOCKED_FOR_KEY}::text, ${RECORDED.blockedFor}::text,
    ${PRIOR_NEEDS_REVIEW_KEY}::text, ${reviewKeptWhenLiftedSql}) || ${ratingKeptWhenLiftedSql}
  ELSE ${stripped} END)`;
}

/** `metadata` for an approved appeal. */
export const liftedMetadataSql = liftedUnderGraceSql(withoutGraceMarkersSql());

/** `metadata` for an unblock: also drops the rule keys; while the owner is deleted, `liftedUnderGraceSql` records the lift for the account restore. */
export const unblockedMetadataSql = liftedUnderGraceSql(
  Prisma.sql`"metadata" - 'ruleId' - 'ruleReason'${minusPriorKeysSql}`
);

/** The `ingestion` a scan error writes. Reads the row before the error's retry count is added. */
export const ingestionAfterScanErrorSql = () => Prisma.sql`(CASE
  WHEN "ingestion" = 'NotFound'::"ImageIngestionStatus" OR "ingestion" = 'Blocked'::"ImageIngestionStatus" THEN "ingestion"
  WHEN "ingestion" = 'Rescan'::"ImageIngestionStatus"
    AND "blockedFor" IS NOT NULL AND "blockedFor" <> ${BlockedReason.AiNotVerified}
    AND COALESCE(("scanJobs"->>'retryCount')::int, 0) + 1 < ${IMAGE_RESCAN_RETRY_LIMIT}
    THEN "ingestion"
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

/** A minor-flagged image the minor content rule restricts, as this viewer sees it: hidden unless they uploaded it or moderate. */
export const minorMatureHidden = (
  image: { userId: number; minor?: boolean | null; nsfwLevel: number } | null | undefined,
  viewerId?: number,
  isModerator?: boolean
) => !!image && !isModerator && image.userId !== viewerId && isMinorMatureImage(image);

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

/**
 * An image with any `blockedFor` reason is visible only to its owner and moderators, as SQL over
 * `"Image" i`. Empty for a moderator.
 */
export function imageBlockedForConditions({
  userId,
  isModerator,
}: {
  userId?: number;
  isModerator?: boolean;
}): Prisma.Sql[] {
  if (isModerator) return [];
  return [
    userId
      ? Prisma.sql`(i."blockedFor" IS NULL OR i."userId" = ${userId})`
      : Prisma.sql`(i."blockedFor" IS NULL)`,
  ];
}
