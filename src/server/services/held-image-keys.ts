import { Prisma } from '@prisma/client';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import {
  servableProfilePictureSql,
  userImageNamesHeldPicture,
  type RawQueryClient,
} from '~/server/services/profile-picture.sql';

/**
 * Whether any image stored under one of `keys` (lowercased, as `keysIn` gives them) is under an
 * owner-hidden review hold. Upper-case forms are matched too; `lower(url)` would skip the url index.
 */
export async function anyImageHeldForReview(db: RawQueryClient, keys: string[]) {
  if (!keys.length) return false;
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image"
    WHERE url IN (${Prisma.join([
      ...keys,
      ...keys.map((key) => key.toUpperCase()),
    ])}) AND "needsReview" IN (${Prisma.join(OWNER_HIDDEN_REVIEWS)})
    LIMIT 1
  `;
  return rows.length > 0;
}

const heldImageMarker = Prisma.raw(
  `jsonb_build_object('heldImageCleared', jsonb_build_object('pictureId', u."profilePictureId"))`
);

/**
 * Of `userIds`, those whose profile picture is under an owner-hidden hold; for each of them whose
 * `User.image` names that picture, clears `User.image` in the same statement and marks it with
 * `meta.heldImageCleared = { pictureId }` (no value: the value is the held key), which
 * `restoreClearedUserImages` reads once the hold lifts. Only an object `meta` takes the marker.
 */
export async function clearHeldUserImages(db: RawQueryClient, userIds: number[]) {
  if (!userIds.length) return [];
  const rows = await db.$queryRaw<{ id: number }[]>`
    WITH held AS (
      SELECT u.id, (u.image IS NOT NULL AND ${Prisma.raw(
        userImageNamesHeldPicture
      )}) AS "namesPicture"
      FROM "User" u
      JOIN "Image" picture ON picture.id = u."profilePictureId"
      WHERE u.id IN (${Prisma.join(userIds)})
        AND picture."needsReview" IN (${Prisma.join(OWNER_HIDDEN_REVIEWS)})
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
    )
    SELECT id FROM held
  `;
  return rows.map((row) => row.id);
}

const MARKED = Prisma.raw(`jsonb_typeof(u.meta) = 'object' AND u.meta ? 'heldImageCleared'`);
// Compared as text, so a marker whose pictureId is not a number never fails the statement.
const MARKER_IS_CURRENT = Prisma.raw(
  `u.meta->'heldImageCleared'->>'pictureId' = u."profilePictureId"::text`
);

/**
 * For those of `userIds` whose `User.image` a hold cleared (`clearHeldUserImages`), puts it back from
 * the profile picture's own url once the picture is servable again (`servableProfilePictureSql`, and no
 * block marker survives on it),
 * is still the user's and `User.image` is still empty. A marker that can no longer apply is dropped by
 * `dropStaleHeldImageMarkers`; one whose picture is not servable yet is kept, so a later lift still
 * restores. The value is rebuilt, never stored. A write that replaces
 * `meta` whole drops the marker, and then nothing is restored: the avatar stays empty, not wrong.
 * The picture row is locked for the statement, so a hold landing meanwhile waits and its own
 * clear then sees the restored value. Runs only in the main app: a hold released in the moderator
 * app restores at the user's next main-app refresh, and until then the avatar stays empty.
 * Returns the ids restored.
 */
export async function restoreClearedUserImages(db: RawQueryClient, userIds: number[]) {
  const ids = [...new Set(userIds)].filter(Number.isInteger);
  if (!ids.length) return [];
  const rows = await db.$queryRaw<{ id: number }[]>`
    WITH picture AS (
      SELECT u.id AS "userId", i.id AS "pictureId", i.url
      FROM "User" u
      JOIN "Image" i ON i.id = u."profilePictureId" AND i."userId" = u.id
      WHERE u.id IN (${Prisma.join(ids)})
        AND ${MARKED}
        AND ${MARKER_IS_CURRENT}
        AND u.image IS NULL
        AND ${servableProfilePictureSql}
        AND NOT ${hasBlockMarkerSql('i')}
      FOR SHARE OF i
    )
    UPDATE "User" u
    SET image = picture.url, meta = u.meta - 'heldImageCleared'
    FROM picture
    WHERE u.id = picture."userId" AND u.image IS NULL AND u."profilePictureId" = picture."pictureId"
    RETURNING u.id
  `;
  return rows.map((row) => row.id);
}

/**
 * Drops `meta.heldImageCleared` where it can no longer apply: the user has another picture or none,
 * or has set `User.image` since. A marker whose picture is not servable yet is kept.
 */
export async function dropStaleHeldImageMarkers(db: RawQueryClient, userIds: number[]) {
  const ids = [...new Set(userIds)].filter(Number.isInteger);
  if (!ids.length) return;
  await db.$queryRaw`
    UPDATE "User" u
    SET meta = u.meta - 'heldImageCleared'
    WHERE u.id IN (${Prisma.join(ids)})
      AND ${MARKED}
      AND (u.image IS NOT NULL OR u."profilePictureId" IS NULL OR NOT ${MARKER_IS_CURRENT})
    RETURNING u.id
  `;
}
