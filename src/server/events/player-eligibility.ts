import { Prisma } from '@prisma/client';
import { TURF_SCORE_TIER_KEY } from '~/server/events/turf/config';
import { UserFlag } from '~/shared/constants/user-flags.constants';

/** The user aliased `u` is not banned, deleted or excluded from event points. */
const inGoodStandingSql = (u: Prisma.Sql) =>
  Prisma.sql`${u}."bannedAt" IS NULL AND ${u}."deletedAt" IS NULL
        AND (${u}.flags & ${UserFlag.ExcludeFromEventPoints}::int) = 0`;

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
