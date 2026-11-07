import { Prisma } from '@prisma/client';
import type { ProfileImage } from '~/server/selectors/image.selector';

/** A profile picture that is Blocked or held for csam review is served as no picture. */
export const servableProfilePictureSql = Prisma.sql`
  i.ingestion <> 'Blocked'::"ImageIngestionStatus"
  AND i."needsReview" IS DISTINCT FROM 'csam'
`;

type RawQueryClient = {
  $queryRaw<T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Prisma.PrismaPromise<T>;
};

/** The profile pictures among `imageIds` that may be served; the rest are left out. */
export async function getServableProfilePictures(db: RawQueryClient, imageIds: number[]) {
  if (!imageIds.length) return [];
  return db.$queryRaw<ProfileImage[]>`
    SELECT i.id, i.name, i.url, i."nsfwLevel", i.hash, i."userId", i.ingestion, i.type,
      i.width, i.height, i.metadata
    FROM "Image" i
    WHERE i.id IN (${Prisma.join(imageIds)}) AND ${servableProfilePictureSql}
  `;
}
