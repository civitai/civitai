import { Prisma } from '@prisma/client';
import { TURF_SCORE_TIER_KEY } from '~/server/events/turf/config';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/** The user aliased `u` is not banned, deleted or excluded from event points. */
const inGoodStandingSql = (u: Prisma.Sql) =>
  Prisma.sql`${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL
        AND (${u}.flags & ${UserFlag.ExcludeFromEventPoints}::int) = 0`;

// A per-user start for the ExcludeFromEventPoints flag: from this UTC day on, the user neither gives
// nor earns event points; what they earned before it stands. Set as an ISO date ('2026-11-25') or a
// UTC midnight timestamp ('2026-11-25T00:00:00.000Z'). A flagged user without it, or with any
// other value, is excluded for the whole season.
export const EVENT_POINTS_EXCLUDED_FROM_META_KEY = 'eventPointsExcludedFrom';
const EXCLUDED_FROM_FORMAT =
  '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])(T00:00(:00(\\.0+)?)?Z)?$';

/**
 * The first UTC day the user aliased `u` neither gives nor earns event points, as a date: 1970-01-01
 * (the whole season) when banned, deleted, or excluded with no valid start; NULL when none of these.
 * Built from the month's first day plus days, so a value like '2026-02-31' rolls over instead of
 * failing the query that reads it.
 */
export const eventPointsExcludedFromSql = (u: Prisma.Sql = Prisma.raw('u')) => {
  const value = Prisma.sql`(${u}.meta ->> ${Prisma.raw(
    `'${EVENT_POINTS_EXCLUDED_FROM_META_KEY}'`
  )})`;
  return Prisma.sql`(CASE
    WHEN ${u}."bannedAt" IS NOT NULL OR ${u}."deletedAt" IS NOT NULL THEN DATE '1970-01-01'
    WHEN (${u}.flags & ${UserFlag.ExcludeFromEventPoints}::int) = 0 THEN NULL
    WHEN ${value} ~ ${EXCLUDED_FROM_FORMAT}::text
      THEN (substr(${value}, 1, 7) || '-01')::date + (substr(${value}, 9, 2)::int - 1)
    ELSE DATE '1970-01-01'
  END)`;
};

/**
 * Whether the user aliased `u` earns for an event: an account from before the event start, or one
 * that has since reached the Spark tier's threshold, read from its CreatorMilestone row so the tier
 * stays the one source (compared as creatorScoreFromMeta: `meta.scores.total`, absent or non-numeric
 * as 0), and not banned, deleted or excluded from event points.
 */
export const eventPlayerEligibleSql = (startDate: Date, u: Prisma.Sql = Prisma.raw('u')) =>
  Prisma.sql`COALESCE(((${u}."createdAt" < ${startDate}
          OR CASE WHEN jsonb_typeof(${u}.meta -> 'scores' -> 'total') = 'number'
            THEN (${u}.meta -> 'scores' ->> 'total')::numeric ELSE 0 END >= (
              SELECT threshold FROM "CreatorMilestone" WHERE key = ${TURF_SCORE_TIER_KEY}
            ))
        AND ${inGoodStandingSql(u)}), false)`;

/**
 * Whether the user aliased `u` misses eventPlayerEligibleSql only on account age and tier. A banned
 * or excluded account is never "too new", so telling a player this reveals nothing else.
 */
export const eventPlayerTooNewSql = (startDate: Date, u: Prisma.Sql = Prisma.raw('u')) =>
  Prisma.sql`COALESCE((${inGoodStandingSql(u)}
        AND NOT ${eventPlayerEligibleSql(startDate, u)}), false)`;
