-- Rewards abuse decision log — ClickHouse DDL.
--
-- Apply this MANUALLY, BEFORE deploying the code that writes to it. We do not auto-run DDL
-- (same policy as the Postgres migrations).
--
-- 🔴 Order matters more than usual here. Inserts in this codebase run
-- `async_insert=1, wait_for_async_insert=0`, so a write to a table that does not exist is
-- NOT an error the caller sees. Ship the code first and the job will report success while
-- logging nothing, for as long as it takes someone to notice.
--
-- What this is for: `rewards-abuse-prevention` disables Buzz rewards in bulk, nightly, with
-- no human in the loop. Before this table the only record of a night's run was an HTTP
-- response body the scheduler discards, so neither "why is this account not earning" nor
-- "what would a different threshold have caught" could be answered without re-running the
-- detection against live data.
--
-- One row per flagged IP per run. The config that produced the row is stored beside it, so
-- reviewing a threshold is a query rather than an experiment.

CREATE TABLE IF NOT EXISTS rewards_abuse_decisions
(
  -- When the run happened, and which run this row belongs to. `runId` groups a night together,
  -- which is what makes a run that flagged nothing distinguishable from a run that did not
  -- happen at all.
  time                DateTime,
  runId               UUID,

  -- Dev and preview both write to production ClickHouse. Without this, a dev run's rows are
  -- indistinguishable from production history.
  env                 LowCardinality(String),
  dryRun              UInt8,

  -- The cluster that was flagged.
  ip                  String,
  userIds             Array(Int32),
  userCount           UInt32,
  ipUserCount         UInt32,
  awarded             UInt32,

  -- Which of `userIds` the run actually disabled. Always empty on a dry run. On a live run it
  -- is a SUBSET of userIds: an account that is Protected, or already Ineligible, is flagged and
  -- then skipped. This is the column that answers "was this account disabled, and why", as
  -- opposed to "this account was near something that got caught".
  disabledUserIds     Array(Int32),

  -- The config that produced this row. Typed columns for the knobs that exist today, so a
  -- threshold sweep is a plain WHERE; `config` carries the whole parsed object so a knob added
  -- later is recorded without a migration.
  awardTypes          Array(String),
  awardTypePrefixes   Array(String),
  awardedThreshold    UInt32,
  userCountThreshold  UInt32,
  maxUserCount        Nullable(UInt32),
  requireExclusiveIp  UInt8,
  config              String,

  -- Run-level, repeated on every row of the run so the table answers questions on its own.
  usersDisabled       UInt32,

  createdDate         Date DEFAULT toDate(time)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(time)
ORDER BY (time, ip);

-- No Enum8 anywhere on purpose: a value outside an Enum8 is dropped server-side on an async
-- insert, so a typo writes zero rows and reports success. LowCardinality(String) costs the
-- same and cannot fail that way.
--
-- No TTL on purpose: the volume is small (a run flags tens to low thousands of rows) and the
-- point of the table is looking back at what an older config did.
