import { CompiledQuery, type Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';
import { OWNER_HIDDEN_REVIEWS } from '@civitai/shared/owner-hidden-reviews';

/** Whether `User.image` (aliased `u`) names the key of the image aliased `alias`, in any url form. */
export const userImageNamesPicture = (alias: string) =>
  `strpos(replace(lower(u.image), '%2d', '-'), lower(${alias}.url)) > 0`;

const heldImageMarker = `jsonb_build_object('heldImageCleared', jsonb_build_object('pictureId', u."profilePictureId"))`;

// The block markers are the main app's `hasBlockMarker`: Blocked ingestion, the Blocked level (32),
// or a block reason.
const CLEAR_HELD_USER_IMAGES_SQL = `
  WITH held AS (
    SELECT u.id, (u.image IS NOT NULL AND ${userImageNamesPicture('picture')}) AS "namesPicture"
    FROM "User" u
    JOIN "Image" picture ON picture.id = u."profilePictureId"
    WHERE u.id = ANY($1::int[])
      AND (
        picture."needsReview" = ANY($2::text[])
        OR picture.ingestion::text = 'Blocked'
        OR picture."nsfwLevel" = 32
        OR picture."blockedFor" IS NOT NULL
      )
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

/**
 * Of `userIds`, those whose profile picture is under an owner-hidden hold or carries a block marker.
 * For each of them whose `User.image` names that picture, clears `User.image` in the same statement
 * and marks it with `meta.heldImageCleared = { pictureId }` (no value: the value is the held key),
 * which the main app's `restoreClearedUserImages` reads once the picture is servable again. Only an
 * object `meta` takes the marker. Plain SQL text, so the main app runs it on Prisma and the moderator
 * app on Kysely (`clearHeldUserImages`).
 */
export const clearHeldUserImagesStatement = (userIds: number[]) => ({
  sql: CLEAR_HELD_USER_IMAGES_SQL,
  parameters: [userIds, OWNER_HIDDEN_REVIEWS] as unknown[],
});

/** `clearHeldUserImagesStatement` on a Kysely client. */
export async function clearHeldUserImages(db: Kysely<DB>, userIds: number[]): Promise<number[]> {
  if (!userIds.length) return [];
  const { sql, parameters } = clearHeldUserImagesStatement(userIds);
  const { rows } = await db.executeQuery<{ id: number }>(CompiledQuery.raw(sql, parameters));
  return rows.map((row) => row.id);
}
