import { Prisma } from '@prisma/client';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import {
  blockMarkerText,
  clearHeldUserImagesStatement,
  clearUserImageKeysStatement,
  pictureUserIdsStatement,
  userImageKeyPlanStatement,
  type ClearedUserImageKeyRow,
  type UserImageKeyPlanRow,
} from '@civitai/db-queries/profile-picture-clear';
import { type RawQueryClient } from '~/server/services/profile-picture.sql';

type RawUnsafeQueryClient = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
};

/**
 * Whether any image stored under one of `keys` (lowercased, as `keysIn` gives them) is under an
 * owner-hidden review hold or carries a block marker. Upper-case forms are matched too; `lower(url)`
 * would skip the url index.
 */
export async function anyImageHeldOrBlocked(db: RawQueryClient, keys: string[]) {
  if (!keys.length) return false;
  const rows = await db.$queryRaw<unknown[]>`
    SELECT 1 FROM "Image"
    WHERE url IN (${Prisma.join([...keys, ...keys.map((key) => key.toUpperCase())])}) AND (
      "needsReview" IN (${Prisma.join(OWNER_HIDDEN_REVIEWS)})
      OR ${Prisma.raw(blockMarkerText('"Image"'))}
    )
    LIMIT 1
  `;
  return rows.length > 0;
}

/**
 * `clearHeldUserImagesStatement` from `@civitai/db-queries/profile-picture-clear`, the statement the
 * moderator app runs too: the users whose profile picture is held or blocked, with any `User.image`
 * naming it (or another held or blocked own image) cleared.
 */
export async function clearHeldUserImages(db: RawUnsafeQueryClient, userIds: number[]) {
  return runStatement(db, clearHeldUserImagesStatement(userIds));
}

/** `pictureUserIdsStatement` from `@civitai/db-queries/profile-picture-clear`. */
export async function getPictureUserIds(db: RawUnsafeQueryClient, imageIds: number[]) {
  return runStatement(db, pictureUserIdsStatement(imageIds));
}

/** `userImageKeyPlanStatement` from `@civitai/db-queries/profile-picture-clear`. */
export async function userImageKeyPlan(db: RawUnsafeQueryClient, limit: number) {
  const { sql, parameters } = userImageKeyPlanStatement(limit);
  return db.$queryRawUnsafe<UserImageKeyPlanRow[]>(sql, ...parameters);
}

/** `clearUserImageKeysStatement` from `@civitai/db-queries/profile-picture-clear`. */
export async function clearUserImageKeys(db: RawUnsafeQueryClient, userIds: number[]) {
  const { sql, parameters, empty } = clearUserImageKeysStatement(userIds);
  if (empty) return [];
  return db.$queryRawUnsafe<ClearedUserImageKeyRow[]>(sql, ...parameters);
}

async function runStatement(
  db: RawUnsafeQueryClient,
  statement: { sql: string; parameters: unknown[]; empty: boolean }
) {
  if (statement.empty) return [];
  const rows = await db.$queryRawUnsafe<{ id: number }[]>(statement.sql, ...statement.parameters);
  return rows.map((row) => row.id);
}
