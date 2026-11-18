import { Prisma } from '@prisma/client';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import {
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

/**
 * Of `userIds`, those whose profile picture is under an owner-hidden hold; for each of them whose
 * `User.image` names that picture, clears `User.image` in the same statement.
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
      UPDATE "User" u SET image = NULL FROM held WHERE u.id = held.id AND held."namesPicture"
      RETURNING u.id
    )
    SELECT id FROM held
  `;
  return rows.map((row) => row.id);
}
