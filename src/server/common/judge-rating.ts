import { Prisma } from '@prisma/client';
import { JUDGE_RATING_METADATA_KEY } from '~/shared/utils/block-provenance-metadata';

/**
 * The level a collection judge recorded in `metadata.judgeRating`, as SQL over `column`, or 0
 * when there is none or it is not a single browsing level. A later scan or tag recompute never
 * writes a level below it.
 */
export const judgeRatingFloorSql = (column = '"metadata"') => {
  const level = Prisma.sql`(${Prisma.raw(
    column
  )} -> ${JUDGE_RATING_METADATA_KEY}::text -> 'nsfwLevel')`;
  return Prisma.sql`(CASE
    WHEN jsonb_typeof(${level}) = 'number' AND ${level}::text IN ('1', '2', '4', '8', '16')
    THEN ${level}::text::int
    ELSE 0
  END)`;
};
