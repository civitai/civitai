import { Prisma } from '@prisma/client';
import { imageReviewedSql } from '~/server/common/image-visibility';
import type { ProfileImage } from '~/server/selectors/image.selector';

/** When a profile picture may be served to anyone but its owner; any other picture is served as none. */
export const servableProfilePictureSql = Prisma.sql`
  i.ingestion <> 'Blocked'::"ImageIngestionStatus"
  AND i."needsReview" IS DISTINCT FROM 'csam'
  AND ${imageReviewedSql('i')}
`;

export type RawQueryClient = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Prisma.PrismaPromise<T>;
};

// `profileImageSelect`'s columns, over `Image` aliased `i`.
const profilePictureColumnsSql = Prisma.sql`i.id, i.name, i.url, i."nsfwLevel", i.hash, i."userId",
  i.ingestion, i.type, i.width, i.height, i.metadata`;

/** The profile pictures among `imageIds` that may be served; the rest are left out. */
export async function getServableProfilePictures(db: RawQueryClient, imageIds: number[]) {
  if (!imageIds.length) return [];
  return db.$queryRaw<ProfileImage[]>`
    SELECT ${profilePictureColumnsSql}
    FROM "Image" i
    WHERE i.id IN (${Prisma.join(imageIds)}) AND ${servableProfilePictureSql}
  `;
}

/**
 * A user's own profile picture whatever its scan state, except one flagged `csam`, for the reads
 * that serve it to its owner or a moderator. Raw SQL: the Prisma find queries null an unscanned
 * picture for every viewer.
 */
export async function getProfilePictureOfUser(db: RawQueryClient, userId: number) {
  const [picture] = await db.$queryRaw<ProfileImage[]>`
    SELECT ${profilePictureColumnsSql}
    FROM "User" u
    JOIN "Image" i ON i.id = u."profilePictureId"
    WHERE u.id = ${userId} AND i."needsReview" IS DISTINCT FROM 'csam'
  `;
  return picture ?? null;
}
