import { Prisma } from '@prisma/client';
import { NsfwLevel } from '@civitai/shared';

/**
 * SQL twin of `isMinorContentRestricted` (`@civitai/shared/minor-content-gate`): true when `minor`
 * holds and `nsfwLevel` is a restricted rating, an unknown rating included. Change the two together;
 * `minor-content-gate.sql.test.ts` runs both over every rating.
 */
export const minorContentRestrictedSql = ({
  minor,
  nsfwLevel,
}: {
  minor: Prisma.Sql;
  nsfwLevel: Prisma.Sql;
}) => Prisma.sql`((${minor}) AND (${nsfwLevel} IS NULL OR ${nsfwLevel} >= ${NsfwLevel.R}))`;
