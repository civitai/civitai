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

/**
 * The first upload key in `User.image` (`User` aliased `user`), lowercased, an encoded dash read as one.
 * Fewer forms than the main app's `keysIn`: the column holds a bare key or a CDN url around one, since
 * the profile save refuses any new key and only the restore writes one (a picture's bare url).
 */
const userImageKeyText = (user: string) =>
  `(regexp_match(replace(lower(${user}.image), '%2d', '-'), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'))[1]`;

/**
 * Whether `Image` aliased `alias` is one of the user's own images stored under the key `User.image`
 * (`User` aliased `user`) names: an equality on the stored url, answered by `Image_url_covered_idx`
 * (declared outside the Prisma schema).
 */
export const ownImageNamedByUserImage = (alias: string, user = 'u') =>
  `(${alias}."userId" = ${user}.id AND ${alias}.url IN (${userImageKeyText(
    user
  )}, upper(${userImageKeyText(user)})))`;

const heldImageMarker = `jsonb_build_object('heldImageCleared', jsonb_build_object('pictureId', u."profilePictureId"))`;

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
    UPDATE "User" u
    SET image = NULL,
      meta = CASE
        WHEN u.meta IS NULL OR jsonb_typeof(u.meta) = 'null' THEN ${heldImageMarker}
        WHEN jsonb_typeof(u.meta) = 'object' THEN u.meta || ${heldImageMarker}
        -- A JSON scalar (the system-account marker can be a string) keeps its value and takes no marker.
        ELSE u.meta
      END
    FROM held WHERE u.id = held.id AND held."namesPicture"
    RETURNING u.id
  ), "namedCleared" AS (
    UPDATE "User" u SET image = NULL FROM named WHERE u.id = named.id RETURNING u.id
  )
  SELECT id FROM held UNION SELECT id FROM "namedCleared"
`;

/**
 * Of `userIds`, those whose profile picture is under an owner-hidden hold or carries a block marker.
 * For each of them whose `User.image` names that picture, clears `User.image` in the same statement
 * and marks it with `meta.heldImageCleared = { pictureId }` (no value: the value is the held key),
 * which the main app's `restoreClearedUserImages` reads once the picture is servable again.
 * Also clears a `User.image` naming another of the user's own images that is held or blocked, with no
 * marker: it is not the profile picture, so nothing puts it back. Returns both sets of users. Plain
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

const MARKED = `jsonb_typeof(u.meta) = 'object' AND u.meta ? 'heldImageCleared'`;
// Compared as text, so a marker whose pictureId is not a number never fails the statement.
const MARKER_IS_CURRENT = `u.meta->'heldImageCleared'->>'pictureId' = u."profilePictureId"::text`;

const RESTORE_CLEARED_USER_IMAGES_SQL = `
  WITH picture AS (
    SELECT u.id AS "userId", i.id AS "pictureId", i.url
    FROM "User" u
    JOIN "Image" i ON i.id = u."profilePictureId" AND i."userId" = u.id
    WHERE u.id = ANY($1::int[])
      AND ${MARKED}
      AND ${MARKER_IS_CURRENT}
      AND u.image IS NULL
      AND ${servablePictureText}
      -- Another of the user's rows stored under the same key, held or blocked, keeps it withheld.
      AND NOT EXISTS (
        SELECT 1 FROM "Image" twin
        WHERE twin."userId" = u.id AND twin.url = i.url AND twin.id <> i.id
          AND ${heldOrBlockedText('twin')}
      )
    FOR SHARE OF i
  )
  UPDATE "User" u
  SET image = picture.url, meta = u.meta - 'heldImageCleared'
  FROM picture
  WHERE u.id = picture."userId" AND u.image IS NULL AND u."profilePictureId" = picture."pictureId"
  RETURNING u.id
`;

const DROP_STALE_HELD_IMAGE_MARKERS_SQL = `
  UPDATE "User" u
  SET meta = u.meta - 'heldImageCleared'
  WHERE u.id = ANY($1::int[])
    AND ${MARKED}
    AND (u.image IS NOT NULL OR u."profilePictureId" IS NULL OR NOT ${MARKER_IS_CURRENT})
  RETURNING u.id
`;

/**
 * For those of `userIds` whose `User.image` the clear emptied, puts it back from the profile
 * picture's own url once the picture is servable again (`servablePictureText`), is still the user's,
 * and `User.image` is still empty. A marker whose picture is not servable yet is kept, so a later lift
 * still restores. The value is rebuilt, never stored. A write that replaces `meta` whole drops the
 * marker, and then nothing is restored: the avatar stays empty, not wrong. The picture row is locked
 * for the statement, so a hold or block landing meanwhile waits and its own clear then sees the
 * restored value. Returns the ids restored.
 */
export const restoreClearedUserImagesStatement = (userIds: number[]) => ({
  sql: RESTORE_CLEARED_USER_IMAGES_SQL,
  parameters: [userIdsParameter(userIds), ...servablePictureParameters],
  empty: !userIdsParameter(userIds).length,
});

/**
 * Drops `meta.heldImageCleared` where it can no longer apply: the user has another picture or none,
 * or has set `User.image` since. A marker whose picture is not servable yet is kept.
 */
export const dropStaleHeldImageMarkersStatement = (userIds: number[]) => ({
  sql: DROP_STALE_HELD_IMAGE_MARKERS_SQL,
  parameters: [userIdsParameter(userIds)],
  empty: !userIdsParameter(userIds).length,
});

/** `restoreClearedUserImagesStatement` on a Kysely client. */
export const restoreClearedUserImages = (db: Kysely<DB>, userIds: number[]) =>
  run(db, restoreClearedUserImagesStatement(userIds));

/** `dropStaleHeldImageMarkersStatement` on a Kysely client. */
export const dropStaleHeldImageMarkers = (db: Kysely<DB>, userIds: number[]) =>
  run(db, dropStaleHeldImageMarkersStatement(userIds));
