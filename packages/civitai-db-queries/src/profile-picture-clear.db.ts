import { CompiledQuery, sql, type Kysely, type RawBuilder } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { KNIGHTS_VOTE_NSFW_LEVEL_REASON } from '@civitai/shared/new-order';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';

const userIdsParameter = (userIds: number[]) => [...new Set(userIds)].filter(Number.isInteger);

type Statement = { sql: string; parameters: unknown[]; empty: boolean };

const run = async (db: Kysely<DB>, statement: Statement) => {
  if (statement.empty) return [];
  const { rows } = await db.executeQuery<{ id: number }>(
    CompiledQuery.raw(statement.sql, statement.parameters)
  );
  return rows.map((row) => row.id);
};

/** Whether `User.image` (`User` aliased `user`) names the key of the image aliased `alias`, in any url form. */
export const userImageNamesPicture = (alias: string, user = 'u') =>
  `(length(${alias}.url) > 0 AND strpos(replace(lower(${user}.image), '%2d', '-'), lower(${alias}.url)) > 0)`;

/**
 * Whether `Image` aliased `alias` is under an owner-hidden review hold ($2, the reviews) or carries a
 * block marker: the one rule the clear applies to every image `User.image` can name.
 */
const heldOrBlockedText = (alias: string) =>
  `(${alias}."needsReview" = ANY($2::text[]) OR ${blockMarkerText(alias)})`;

/** An upload key: a uuid, matched on text already lowercased. */
export const UPLOAD_KEY_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/** `column` lowercased, an encoded dash read as one. */
const normalisedKeyText = (column: string) => `replace(lower(${column}), '%2d', '-')`;

/**
 * Whether the text column `column` holds an upload key, in the forms this rule reads: any case, and a
 * dash written as %2d. Fewer forms than the main app's `keysIn`, which also decodes other
 * percent-escapes and splits; the profile save refuses every form `keysIn` finds. The one definition
 * the `User.image` key count, its clean-up and its constraint use.
 */
export const holdsUploadKeyText = (column: string) =>
  `(${normalisedKeyText(column)} ~ '${UPLOAD_KEY_PATTERN}')`;

/** The first upload key in `User.image` (`User` aliased `user`), in the forms `holdsUploadKeyText` reads. */
const userImageKeyText = (user: string) =>
  `(regexp_match(${normalisedKeyText(`${user}.image`)}, '${UPLOAD_KEY_PATTERN}'))[1]`;

/**
 * Whether `Image` aliased `alias` is one of the user's own images stored under the key `User.image`
 * (`User` aliased `user`) names: an equality on the stored url, answered by `Image_url_covered_idx`.
 */
export const ownImageNamedByUserImage = (alias: string, user = 'u') =>
  `(${alias}."userId" = ${user}.id AND ${alias}.url IN (${userImageKeyText(
    user
  )}, upper(${userImageKeyText(user)})))`;

/** The main app's `hasBlockMarkerSql` over `Image` aliased `alias`: Blocked ingestion, the Blocked level, or a block reason. */
export const blockMarkerText = (alias: string) =>
  `(${alias}.ingestion::text = 'Blocked' OR ${alias}."nsfwLevel" = 32 OR ${alias}."blockedFor" IS NOT NULL)`;

const CLEAR_HELD_USER_IMAGES_SQL = `
  WITH held AS (
    SELECT u.id, (u.image IS NOT NULL AND ${userImageNamesPicture('picture')}) AS "namesPicture"
    FROM "User" u
    JOIN "Image" picture ON picture.id = u."profilePictureId"
    WHERE u.id = ANY($1::int[]) AND ${heldOrBlockedText('picture')}
  ), named AS (
    SELECT DISTINCT u.id
    FROM "User" u
    JOIN "Image" other ON ${ownImageNamedByUserImage('other')}
    WHERE u.id = ANY($1::int[])
      AND other.id IS DISTINCT FROM u."profilePictureId"
      AND ${heldOrBlockedText('other')}
      AND NOT EXISTS (SELECT 1 FROM held WHERE held.id = u.id AND held."namesPicture")
  ), cleared AS (
    UPDATE "User" u SET image = NULL FROM held WHERE u.id = held.id AND held."namesPicture"
    RETURNING u.id
  ), "namedCleared" AS (
    UPDATE "User" u SET image = NULL FROM named WHERE u.id = named.id RETURNING u.id
  )
  SELECT id FROM held UNION SELECT id FROM "namedCleared"
`;

/**
 * Of `userIds`, those whose profile picture is under an owner-hidden hold or carries a block marker.
 * For each of them whose `User.image` names that picture, clears `User.image` in the same statement.
 * Also clears a `User.image` naming another of the user's own images that is held or blocked. Nothing
 * puts either back: a servable picture is served through `profilePicture`. Returns both sets of users. Plain
 * SQL text, so the main app runs it on Prisma and the moderator app on Kysely (`clearHeldUserImages`).
 */
export const clearHeldUserImagesStatement = (userIds: number[]) => ({
  sql: CLEAR_HELD_USER_IMAGES_SQL,
  parameters: [userIdsParameter(userIds), OWNER_HIDDEN_REVIEWS] as unknown[],
  empty: !userIdsParameter(userIds).length,
});

const PICTURE_USER_IDS_SQL = `
  SELECT u.id FROM "User" u WHERE u."profilePictureId" = ANY($1::int[])
  UNION
  SELECT u.id FROM "Image" i JOIN "User" u ON u.id = i."userId"
  WHERE i.id = ANY($1::int[]) AND ${ownImageNamedByUserImage('i')}
`;

/**
 * The users an image change can reach through their avatar: those whose profile picture is one of
 * `imageIds`, and the owners whose `User.image` names one of them.
 */
export const pictureUserIdsStatement = (imageIds: number[]) => ({
  sql: PICTURE_USER_IDS_SQL,
  parameters: [userIdsParameter(imageIds)] as unknown[],
  empty: !userIdsParameter(imageIds).length,
});

/** `pictureUserIdsStatement` on a Kysely client. */
export const pictureUserIds = (db: Kysely<DB>, imageIds: number[]) =>
  run(db, pictureUserIdsStatement(imageIds));

/** `clearHeldUserImagesStatement` on a Kysely client. */
export const clearHeldUserImages = (db: Kysely<DB>, userIds: number[]) =>
  run(db, clearHeldUserImagesStatement(userIds));

/** The main app's `nsfwBrowsingLevelsFlag` and `ImageScanFailureClass.Permanent`; its tests pin both. */
export const NSFW_BROWSING_LEVELS_FLAG = 60;
export const PERMANENT_SCAN_FAILURE = 'permanent';

/**
 * The main app's `servableProfilePictureSql` over `Image` aliased `i`, plus no block marker, with
 * $2 the owner-hidden reviews, $3 the Knights vote reason, $4 the permanent scan-failure class and $5
 * the mature-level flag (`servablePictureParameters`). Main's tests pin it to the Prisma original.
 */
export const servablePictureText = `
  i.ingestion::text <> 'Blocked'
  AND i."nsfwLevel" != 0
  AND (i."needsReview" IS NULL OR NOT (i."needsReview" = ANY($2::text[])))
  AND (
    i.ingestion::text = 'Scanned'
    OR (
      i."nsfwLevelLocked" = TRUE
      AND i.ingestion::text NOT IN ('Blocked', 'NotFound')
      AND NOT (
        i.ingestion::text = 'Error'
        AND (
          COALESCE(i.metadata->>'nsfwLevelReason', '') = $3
          OR COALESCE(i."scanJobs"->'error'->>'failureClass', '') = $4
          OR COALESCE(i."scanJobs"->'lastFailure'->>'failureClass', '') = $4
          OR COALESCE(i."scanJobs"->'permanentFailure' = 'true'::jsonb, FALSE)
        )
      )
    )
  )
  AND ((i."nsfwLevel" & $5::int) = 0 OR NOT i."modelRestricted")
  AND NOT ${blockMarkerText('i')}
`;

export const servablePictureParameters = [
  OWNER_HIDDEN_REVIEWS,
  KNIGHTS_VOTE_NSFW_LEVEL_REASON,
  PERMANENT_SCAN_FAILURE,
  NSFW_BROWSING_LEVELS_FLAG,
] as unknown[];

/**
 * `servablePictureText` as a Kysely fragment over `Image` aliased `i`, each `$n` bound to
 * `parameters[n - 2]`. A placeholder with no parameter throws, so the text and its parameters cannot
 * drift apart silently.
 */
export const servablePictureSql = (
  text = servablePictureText,
  parameters = servablePictureParameters
): RawBuilder<boolean> => {
  const fragments = text.split(/\$(\d+)/).map((part, index) => {
    if (index % 2 === 0) return sql.raw(part);
    const position = Number(part) - 2;
    if (position < 0 || position >= parameters.length)
      throw new Error(`servablePictureSql: $${part} has no parameter`);
    return sql.val(parameters[position]);
  });
  return sql<boolean>`(${sql.join(fragments, sql.raw(''))})`;
};

const queuedImageText = (alias: string) =>
  `EXISTS (SELECT 1 FROM "JobQueue" jq WHERE jq."entityType" = 'Image' AND jq."entityId" = ${alias}.id)`;

/**
 * The user's own image a `User.image` key names that can become their profile picture: servable as a
 * picture and with no queued job (a queued delete would reap it after the move).
 */
const movableImageText = `(
  SELECT i.id FROM "Image" i
  WHERE ${ownImageNamedByUserImage('i')} AND ${servablePictureText} AND NOT ${queuedImageText('i')}
  ORDER BY i.id LIMIT 1
)`;

const USER_IMAGE_KEY_PLAN_SQL = `
  SELECT u.id,
    u."profilePictureId" IS NOT NULL AS "hasPicture",
    ${movableImageText} AS "movableImageId",
    EXISTS (
      SELECT 1 FROM "Image" i WHERE ${ownImageNamedByUserImage('i')} AND ${queuedImageText('i')}
    ) AS "keyImageQueued"
  FROM "User" u
  WHERE u.id > 0 AND u.image IS NOT NULL AND ${holdsUploadKeyText('u.image')}
  ORDER BY u.id
  LIMIT $1
`;

export type UserImageKeyPlanRow = {
  id: number;
  hasPicture: boolean;
  movableImageId: number | null;
  keyImageQueued: boolean;
};

/**
 * The users whose `User.image` holds an upload key (`holdsUploadKeyText`), at most `limit`, each with
 * whether they have a profile picture and which own image the key could become their picture.
 */
export const userImageKeyPlanStatement = (limit: number) => ({
  sql: USER_IMAGE_KEY_PLAN_SQL,
  parameters: [limit, ...servablePictureParameters] as unknown[],
});

const CLEAR_USER_IMAGE_KEYS_SQL = `
  WITH target AS (
    SELECT u.id, u.image, u."profilePictureId"
    FROM "User" u
    WHERE u.id = ANY($1::int[]) AND u.image IS NOT NULL AND ${holdsUploadKeyText('u.image')}
    FOR UPDATE
  )
  UPDATE "User" u
  SET image = NULL,
    "profilePictureId" = CASE
      WHEN u."profilePictureId" IS NULL THEN ${movableImageText}
      ELSE u."profilePictureId"
    END
  FROM target t
  WHERE u.id = t.id
  RETURNING u.id, t.image AS "previousImage", t."profilePictureId" AS "previousPictureId",
    u."profilePictureId" AS "pictureId"
`;

export type ClearedUserImageKeyRow = {
  id: number;
  previousImage: string;
  previousPictureId: number | null;
  pictureId: number | null;
};

/**
 * Of `userIds`, empties each `User.image` that holds an upload key, in one statement. A user with no
 * profile picture whose key names an own image `movableImageText` accepts gets that image as their
 * picture instead of losing the avatar. Returns the previous values, the only copy of them.
 */
export const clearUserImageKeysStatement = (userIds: number[]) => ({
  sql: CLEAR_USER_IMAGE_KEYS_SQL,
  parameters: [userIdsParameter(userIds), ...servablePictureParameters] as unknown[],
  empty: !userIdsParameter(userIds).length,
});
