import { Prisma } from '@prisma/client';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import { hasBlockMarkerSql } from '~/server/common/image-visibility';
import { clearHeldUserImagesStatement } from '@civitai/db-queries/profile-picture-clear';
import {
  servableProfilePictureSql,
  type RawQueryClient,
} from '~/server/services/profile-picture.sql';

type RawUnsafeQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

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

/**
 * `clearHeldUserImagesStatement` from `@civitai/db-queries/profile-picture-clear`, the statement the
 * moderator app runs too: the users whose profile picture is held or blocked, with any `User.image`
 * naming it cleared and marked for `restoreClearedUserImages`.
 */
export async function clearHeldUserImages(db: RawUnsafeQueryClient, userIds: number[]) {
  if (!userIds.length) return [];
  const { sql, parameters } = clearHeldUserImagesStatement(userIds);
  const rows = await db.$queryRawUnsafe<{ id: number }[]>(sql, ...parameters);
  return rows.map((row) => row.id);
}

const MARKED = Prisma.raw(`jsonb_typeof(u.meta) = 'object' AND u.meta ? 'heldImageCleared'`);
// Compared as text, so a marker whose pictureId is not a number never fails the statement.
const MARKER_IS_CURRENT = Prisma.raw(
  `u.meta->'heldImageCleared'->>'pictureId' = u."profilePictureId"::text`
);

/**
 * For those of `userIds` whose `User.image` a hold or block cleared (`clearHeldUserImages`), puts it back from
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
