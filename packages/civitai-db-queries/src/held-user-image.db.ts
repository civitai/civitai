// The main app's owner-hidden review holds (OWNER_HIDDEN_REVIEWS), repeated until the list is shared.
const HELD_REVIEWS = ['csam', 'minor'];

/** Runs one parameterised statement ($1, $2, …) and returns its rows: each app passes its own client. */
export type RawQuery = (text: string, values: unknown[]) => Promise<unknown[] | undefined>;

const MARKED = `jsonb_typeof(u.meta) = 'object' AND u.meta ? 'heldImageCleared'`;
// Compared as text, so a marker whose pictureId is not a number never fails the statement.
const MARKER_IS_CURRENT = `u.meta->'heldImageCleared'->>'pictureId' = u."profilePictureId"::text`;

/**
 * For those of `userIds` whose `User.image` a hold cleared (`meta.heldImageCleared`), puts it back
 * from the profile picture's own url once the picture is no longer held, still theirs and
 * `User.image` is still empty; drops a marker that can no longer apply (another picture, or a
 * `User.image` set since). The value is rebuilt, never stored, so a marker a user wrote can only
 * restore their own current, unheld picture. A write that replaces `meta` whole drops the marker,
 * and then nothing is restored, which leaves the avatar empty rather than wrong. Returns the ids
 * restored.
 */
export async function restoreClearedUserImages(
  query: RawQuery,
  userIds: number[]
): Promise<number[]> {
  const ids = [...new Set(userIds)].filter(Number.isInteger);
  if (!ids.length) return [];
  const restored = (await query(
    `UPDATE "User" u
    SET image = picture.url, meta = u.meta - 'heldImageCleared'
    FROM "Image" picture
    WHERE u.id = ANY($1::int[])
      AND ${MARKED}
      AND picture.id = u."profilePictureId"
      AND ${MARKER_IS_CURRENT}
      AND u.image IS NULL
      AND (picture."needsReview" IS NULL OR picture."needsReview" <> ALL($2::text[]))
    RETURNING u.id`,
    [ids, HELD_REVIEWS]
  )) as { id: number }[] | undefined;
  await query(
    `UPDATE "User" u
    SET meta = u.meta - 'heldImageCleared'
    WHERE u.id = ANY($1::int[])
      AND ${MARKED}
      AND (u.image IS NOT NULL OR u."profilePictureId" IS NULL OR NOT ${MARKER_IS_CURRENT})`,
    [ids]
  );
  return (restored ?? []).map((row) => row.id);
}
