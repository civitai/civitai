import { Prisma } from '@prisma/client';
import { JUDGE_RATING_METADATA_KEY } from '~/shared/utils/block-provenance-metadata';

/**
 * `metadata` over `Image` aliased `alias`, with a legacy `judgeRating` seeded from its current level
 * when that is a single browsing level and it has no judge rating yet: the level judges applied
 * before ratings were recorded stays a floor under a rescan. A legacy rating never approves.
 */
export const legacyJudgeRatingSeedSql = (alias: string, collectionId: Prisma.Sql) => {
  const i = Prisma.raw(`"${alias}"`);
  return Prisma.sql`(CASE
    WHEN ${i}."nsfwLevel" IN (1, 2, 4, 8, 16)
      AND NOT COALESCE(${i}."metadata" ? ${JUDGE_RATING_METADATA_KEY}::text, false)
    THEN COALESCE(${i}."metadata", '{}'::jsonb) || jsonb_build_object(
      ${JUDGE_RATING_METADATA_KEY}::text,
      jsonb_build_object(
        'userId', NULL,
        'nsfwLevel', ${i}."nsfwLevel",
        'ratedAt', NULL,
        'legacy', true,
        'collectionId', ${collectionId}
      )
    )
    ELSE ${i}."metadata"
  END)`;
};

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
