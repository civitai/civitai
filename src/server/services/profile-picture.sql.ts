import { Prisma } from '@prisma/client';
import {
  hasBlockMarkerSql,
  imageNotRestrictedSql,
  imageReviewedSql,
  notHeldForReviewSql,
} from '~/server/common/image-visibility';
import { blockMarkerText, userImageNamesPicture } from '@civitai/db-queries/profile-picture-clear';
import { OWNER_HIDDEN_REVIEWS } from '~/server/common/owner-hidden-reviews';
import type { ProfileImage } from '~/server/selectors/image.selector';

/** When a profile picture may be served to anyone but its owner; any other picture is served as none. */
export const servableProfilePictureSql = Prisma.sql`
  i.ingestion <> 'Blocked'::"ImageIngestionStatus"
  AND i."nsfwLevel" != 0
  AND ${notHeldForReviewSql()}
  AND ${imageReviewedSql('i')}
  AND ${imageNotRestrictedSql()}
  AND NOT ${hasBlockMarkerSql('i')}
`;

const heldReviewList = OWNER_HIDDEN_REVIEWS.map((review) => `'${review}'`).join(', ');

/**
 * Whether `User.image` (aliased `u`) names the user's profile picture while it is under an
 * owner-hidden hold or carries a block marker.
 */
export const userImageNamesHeldPicture = `EXISTS (
    SELECT 1 FROM "Image" held
    WHERE held.id = u."profilePictureId"
      AND (held."needsReview" IN (${heldReviewList}) OR ${blockMarkerText('held')})
      AND ${userImageNamesPicture('held')}
  )`;

/**
 * `User.image` over `User` aliased `u`, for reads that fall back to it when there is no profile
 * picture: null when it names the user's profile picture and that picture is under an owner-hidden
 * review hold or carries a block marker, the same rule the clear follows. A raw column for `SELECT`
 * lists built as text.
 */
export const fallbackUserImageColumn = `CASE WHEN ${userImageNamesHeldPicture} THEN NULL ELSE u.image END`;

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
 * A user's own profile picture whatever its scan state, except one under an owner-hidden review hold
 * (`notHeldForReviewSql`), for the reads
 * that serve it to its owner or a moderator. Raw SQL: the Prisma find queries null an unscanned
 * picture for every viewer.
 */
export async function getProfilePictureOfUser(db: RawQueryClient, userId: number) {
  const [picture] = await db.$queryRaw<ProfileImage[]>`
    SELECT ${profilePictureColumnsSql}
    FROM "User" u
    JOIN "Image" i ON i.id = u."profilePictureId"
    WHERE u.id = ${userId} AND ${notHeldForReviewSql()}
  `;
  return picture ?? null;
}
