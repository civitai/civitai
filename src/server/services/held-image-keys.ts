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
 * Clears `User.image` for those of `userIds` whose `User.image` names their profile picture while it
 * is under an owner-hidden hold; returns the ids it cleared.
 */
export async function clearHeldUserImages(db: RawQueryClient, userIds: number[]) {
  if (!userIds.length) return [];
  const rows = await db.$queryRaw<{ id: number }[]>`
    UPDATE "User" u SET image = NULL
    WHERE u.id IN (${Prisma.join(userIds)}) AND u.image IS NOT NULL
      AND ${Prisma.raw(userImageNamesHeldPicture)}
    RETURNING u.id
  `;
  return rows.map((row) => row.id);
}
