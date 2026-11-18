import { Prisma } from '@prisma/client';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import type { RawQueryClient } from '~/server/services/profile-picture.sql';

/** Whether any image stored under one of `keys` is under an owner-hidden review hold. */
export async function anyImageHeldForReview(db: RawQueryClient, keys: string[]) {
  if (!keys.length) return false;
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image"
    WHERE url IN (${Prisma.join(keys)}) AND "needsReview" IN (${Prisma.join(OWNER_HIDDEN_REVIEWS)})
    LIMIT 1
  `;
  return rows.length > 0;
}
