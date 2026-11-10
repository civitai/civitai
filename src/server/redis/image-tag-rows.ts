import type { PrismaClient } from '@prisma/client';
import { styleTags, subjectTags } from '~/libs/tags';
import type { TagSource } from '~/shared/utils/prisma/enums';

export type ImageTagRow = { imageId: number; source: TagSource; tagId: number };

/**
 * Tag names a Rekognition tag keeps even when the image also has WD14 tags. Compared
 * case-sensitively, as the JS filter that preceded this did (`Tag.name` is citext, hence the
 * `::text` casts below).
 */
export const REKOGNITION_ALWAYS_KEPT_TAG_NAMES = [...styleTags, ...subjectTags];

/**
 * The enabled tag rows for a batch of images, as `tagIdsForImagesCache` stores them.
 *
 * A Rekognition row is left out when the same image also has an enabled WD14 row, unless its tag
 * is a Moderation tag, has an empty name, or is named in REKOGNITION_ALWAYS_KEPT_TAG_NAMES. A row
 * whose tag no longer exists is returned either way: the caller drops tags it cannot resolve.
 * This filter used to run in JS over every row; it runs here so those rows never leave the
 * database.
 *
 * Binds the ids as ONE array parameter (`= ANY($1::int[])`), not Prisma's expanded `IN ($1…$n)`:
 * on Postgres 18 pg_stat_statements hashes a parameter that follows an IN-list by its position,
 * so an expanded list gets a separate query id per list length. Don't convert back to `findMany`.
 * The kept names are bound as one array for the same reason.
 */
export async function getImageTagRows(
  db: Pick<PrismaClient, '$queryRaw'>,
  imageIds: number[]
): Promise<ImageTagRow[]> {
  if (!imageIds.length) return [];
  return db.$queryRaw<ImageTagRow[]>`
    SELECT toi."imageId", toi."source", toi."tagId"
    FROM "TagsOnImageDetails" toi
    WHERE toi."imageId" = ANY(${imageIds}::int[]) AND toi."disabled" = false
      AND NOT (
        toi."source" = 'Rekognition'
        AND EXISTS (
          SELECT 1 FROM "TagsOnImageDetails" wd
          WHERE wd."imageId" = toi."imageId" AND wd."source" = 'WD14' AND wd."disabled" = false
        )
        AND EXISTS (
          SELECT 1 FROM "Tag" t
          WHERE t.id = toi."tagId" AND t.type <> 'Moderation' AND t.name::text <> ''
            AND t.name::text <> ALL(${REKOGNITION_ALWAYS_KEPT_TAG_NAMES}::text[])
        )
      )
  `;
}
