-- Drops the 35 "UserRank" columns that exist in the database and hold nothing.
--
-- APPLY BY HAND. We do not run `prisma migrate deploy` or `migrate resolve`.
--
-- Idempotent: every clause is DROP COLUMN IF EXISTS, so re-applying to an environment that
-- already has the state is a no-op, and an environment that never had a given column is fine.
--
-- NOT reversible: the columns cannot be restored by an inverse migration. That is acceptable
-- because they hold no data to lose — see the verification below. If the metric-driven ranking
-- is ever revived, re-adding them is an ALTER TABLE ADD COLUMN of NULLABLE BIGINTs with no
-- column default: that is what prod actually had. The model declared them `Int? @default(0)`,
-- but `atthasdef` is false on all 40 columns — the default only ever existed Prisma-side.
--
-- VERIFIED on the prod REPLICA (read-only, 2026-08-19), reading pg_catalog rather than
-- information_schema — information_schema filters by column privilege, so a column you cannot
-- see reads identically to one that does not exist:
--
--   * "UserRank" is relkind 'r' (a real table), 40 columns, 1750 rows.
--   * SELECT count(*), count("leaderboardRank"), count("downloadCountAllTimeRank"),
--       count("ratingAllTimeRank"), count("followerCountAllTimeRank"), count("answerCountAllTimeRank")
--     -> 1750, 1750, 0, 0, 0, 0. Every column dropped here is NULL in every row.
--   * The 35 names below were diffed against pg_catalog: each one exists, and the five that
--     remain ("userId" and the four leaderboard* columns) are exactly the rest of the table.
--
-- NOTHING READS THEM. That claim is the one this migration rests on, so here is how it was
-- established rather than merely asserted — four ways a column can reach SQL, each checked:
--
--   0. Production is not on fire. The model also declared 10 thumbsUp*/thumbsDown* rank columns
--      that do not exist in the database at all, so any query selecting the whole relation would
--      be erroring on every request today. It is not. That is evidence from production, not from
--      a search, and it is the strongest single argument that route 2 below is really empty.
--   1. By name: `thumbs*Rank` / the 35 names appear only in schema.full.prisma, the generated
--      models.ts + kysely/types.ts, and the schema-drift baseline and its tests.
--   2. Whole-relation select: `rank: true` / `include: { rank: true }` makes Prisma emit EVERY
--      declared column, so one of these would already be failing today. Zero matches repo-wide.
--      A name-grep alone would have missed this, which is why it is called out.
--   3. Raw SQL: three sites read "UserRank" (users.search-index.ts, apply-discord-roles.ts,
--      push-discord-metadata.ts). All name their columns explicitly; no SELECT *.
--   4. Kysely and computed keys: no selectFrom('UserRank')/selectAll('UserRank'); the
--      [`x${period}Rank`] key-building sites are all Bounty/Question/Model ranks.
--
-- The only writer is leaderboardRankInsert (src/server/services/user.service.ts), whose INSERT
-- names "userId" and the four leaderboard* columns. What used to populate these columns is the
-- `rank:` block in src/server/metrics/user.metrics.ts, commented out.

-- Bound the lock wait rather than the statement. The ALTER is metadata-only and takes
-- microseconds; what costs is ACQUIRING ACCESS EXCLUSIVE. Postgres' lock queue is FIFO, so a
-- migration waiting on a long reader parks every later UserRank reader behind it. Measured on
-- the replica 2026-08-19: lock_timeout is 0 (wait forever) and idle_in_transaction_session_timeout
-- is 300s, so an unguarded apply can block profile reads, the user search-index sync and the two
-- Discord jobs for minutes. If this fails, retry — failing fast is the point.
--
-- Avoid 00:01 UTC and the hourly event runs: updateLeaderboardRank TRUNCATEs and refills this
-- table inside one transaction (~196 ms on prod), so the two would simply serialise.
--
-- SET LOCAL, not SET: a bare SET is session-scoped, so it would leave a 3s lock_timeout on
-- whatever the operator types next in the same psql session.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE "UserRank"
  DROP COLUMN IF EXISTS "downloadCountDayRank",
  DROP COLUMN IF EXISTS "downloadCountWeekRank",
  DROP COLUMN IF EXISTS "downloadCountMonthRank",
  DROP COLUMN IF EXISTS "downloadCountYearRank",
  DROP COLUMN IF EXISTS "downloadCountAllTimeRank",
  DROP COLUMN IF EXISTS "favoriteCountDayRank",
  DROP COLUMN IF EXISTS "favoriteCountWeekRank",
  DROP COLUMN IF EXISTS "favoriteCountMonthRank",
  DROP COLUMN IF EXISTS "favoriteCountYearRank",
  DROP COLUMN IF EXISTS "favoriteCountAllTimeRank",
  DROP COLUMN IF EXISTS "ratingCountDayRank",
  DROP COLUMN IF EXISTS "ratingCountWeekRank",
  DROP COLUMN IF EXISTS "ratingCountMonthRank",
  DROP COLUMN IF EXISTS "ratingCountYearRank",
  DROP COLUMN IF EXISTS "ratingCountAllTimeRank",
  DROP COLUMN IF EXISTS "ratingDayRank",
  DROP COLUMN IF EXISTS "ratingWeekRank",
  DROP COLUMN IF EXISTS "ratingMonthRank",
  DROP COLUMN IF EXISTS "ratingYearRank",
  DROP COLUMN IF EXISTS "ratingAllTimeRank",
  DROP COLUMN IF EXISTS "followerCountDayRank",
  DROP COLUMN IF EXISTS "followerCountWeekRank",
  DROP COLUMN IF EXISTS "followerCountMonthRank",
  DROP COLUMN IF EXISTS "followerCountYearRank",
  DROP COLUMN IF EXISTS "followerCountAllTimeRank",
  DROP COLUMN IF EXISTS "answerCountDayRank",
  DROP COLUMN IF EXISTS "answerCountWeekRank",
  DROP COLUMN IF EXISTS "answerCountMonthRank",
  DROP COLUMN IF EXISTS "answerCountYearRank",
  DROP COLUMN IF EXISTS "answerCountAllTimeRank",
  DROP COLUMN IF EXISTS "answerAcceptCountDayRank",
  DROP COLUMN IF EXISTS "answerAcceptCountWeekRank",
  DROP COLUMN IF EXISTS "answerAcceptCountMonthRank",
  DROP COLUMN IF EXISTS "answerAcceptCountYearRank",
  DROP COLUMN IF EXISTS "answerAcceptCountAllTimeRank";

COMMIT;
