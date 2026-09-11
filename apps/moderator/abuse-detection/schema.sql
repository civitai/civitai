-- Abuse-detection reports from automated detectors.
--
-- Lives in the `internal_tools` instance (MODERATOR_DATABASE_URL), NOT the legacy Retool database
-- (RETOOL_DATABASE_URL) that `getModeratorDb()` reads. Those are different instances; the Retool one
-- is what the migration is moving away from, so nothing new should land there.
--
-- 🔴 APPLIED BY HAND, in both environments. Repo convention: no `prisma migrate deploy`, no auto-run
-- on deploy, and this file is not wired to any runner (same as apps/moderator/xguard-lab/schema*.sql).
-- Applying it is a deliberate act by a human, and the app degrades rather than crashes when the
-- tables are absent — see `abuse-detection.service.ts`.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/abuse-detection/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Running this
-- as `postgres` — the natural `kubectl exec … psql -U postgres` shortcut — creates postgres-owned
-- tables the app cannot read, and the page then reports a permission error it cannot distinguish
-- from an outage without the 42501 branch it now carries. If you already did that, either re-run as
-- the app role or:
--   GRANT SELECT, INSERT, UPDATE, DELETE ON abuse_detection_run, abuse_detection_finding TO internal_tools;
--   GRANT USAGE, SELECT ON SEQUENCE abuse_detection_run_id_seq, abuse_detection_finding_id_seq TO internal_tools;
--
-- 🔴 `MODERATOR_DATABASE_URL` and `RETOOL_DATABASE_URL` currently resolve to the SAME instance
-- (the same `internal_tools` database, measured 2026-08-21, post-Retool-cutover). Either works
-- today; this names the one whose purpose is new moderator data.
--
-- Idempotent: safe to re-run.

-- 🔴 REQUIRED. Without it psql continues past a failed statement, and the one environment the DROP
-- below targets — one that ran an earlier version and may hold duplicate (detector, started_at)
-- rows — is exactly where the CREATE UNIQUE INDEX fails. It would then drop the old index anyway,
-- leaving that deployment with NO unique index (every write 42P10s) and no per-detector index either.
\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS abuse_detection_run (
  id          bigserial PRIMARY KEY,
  -- Opaque producer key (`reaction-abuse`, `review-bomb`, …). The UI supplies the display name.
  detector    text        NOT NULL,
  -- The PRODUCER's clock, not receipt time. A run that finishes at 11:20 and reports at 11:47 after
  -- a retry must not read as an 11:47 run — the whole point of the board is "how current is this".
  started_at  timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  summary     text,
  -- Per-detector counters. jsonb rather than columns because each detector counts different things,
  -- and a fixed column set would make adding a counter a schema migration in two repos.
  counters    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- 🔴 IDEMPOTENCY KEY, not just an index. The producers retry: a POST that commits but whose response
-- is lost to a timeout is sent again, and without this the board grows a duplicate run each time —
-- two rows claiming to be the same run, which is worse than none because a reader cannot tell which
-- is current. The service upserts on this pair. It doubles as the (detector, started_at) index the
-- board's per-detector listing needs, so there is no separate one.
--
-- ⚠️ On an existing deployment, de-duplicate before adding it:
--   DELETE FROM abuse_detection_run a USING abuse_detection_run b
--    WHERE a.detector = b.detector AND a.started_at = b.started_at AND a.id < b.id;
-- Keeps the HIGHEST id, i.e. the most recently inserted duplicate. The runtime upsert reaches the
-- same CONTENT a different way — it keeps the original row's id and overwrites its columns — so the
-- two agree on which report survives, not on which row identity does.
CREATE UNIQUE INDEX IF NOT EXISTS abuse_detection_run_detector_started_key
  ON abuse_detection_run (detector, started_at);
-- Superseded by the unique index above: same columns in the same order, and btree scans backward,
-- so it serves `WHERE detector = $1 ORDER BY started_at DESC` identically. (A shared LEADING column
-- would NOT be sufficient grounds — the full column list matching is.) Dropped rather than left
-- behind: an environment that ran an earlier copy of this file still carries it, and a redundant
-- index is pure write cost on every insert.
DROP INDEX IF EXISTS abuse_detection_run_detector_started_idx;

CREATE INDEX IF NOT EXISTS abuse_detection_run_started_idx
  ON abuse_detection_run (started_at DESC);

CREATE TABLE IF NOT EXISTS abuse_detection_finding (
  id         bigserial PRIMARY KEY,
  run_id     bigint      NOT NULL REFERENCES abuse_detection_run (id) ON DELETE CASCADE,
  -- The account the finding is ABOUT. Not an actor, and deliberately not FK'd — this database does
  -- not hold the main app's User table, and a dangling id is a real state (deleted account) rather
  -- than corruption.
  user_id    integer     NOT NULL,
  -- The producer's own 0..1 confidence. NOT comparable across detectors; the UI must not rank on it
  -- across rows from different producers.
  confidence real        NOT NULL,
  reason     text        NOT NULL,
  -- 🔴 The column this table exists for. `false` is the common case: detected, scored, and
  -- deliberately NOT acted on. No pre-existing surface can represent that, and it is precisely what
  -- a human review queue needs to see.
  actioned   boolean     NOT NULL,
  -- What was done, when something was (`exclude`, `unexclude`, …). NULL when `actioned` is false.
  action     text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- An action name without an action, or an action that names nothing, is incoherent either way.
  CONSTRAINT abuse_detection_finding_action_matches_actioned
    CHECK ((actioned AND action IS NOT NULL) OR (NOT actioned AND action IS NULL))
);

CREATE INDEX IF NOT EXISTS abuse_detection_finding_run_idx
  ON abuse_detection_finding (run_id);
-- "What has any detector said about this account?" — the per-user lookup the moderator app joins on.
CREATE INDEX IF NOT EXISTS abuse_detection_finding_user_idx
  ON abuse_detection_finding (user_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- THE MODERATOR'S RULING.
--
-- 🔴 `verdict` IS NOT `actioned`, AND CONFLATING THE TWO IS THE MOST LIKELY BUG THIS TABLE WILL EVER
-- HAVE. `actioned`/`action` above are the PRODUCER's self-report: what the detector did, written by
-- the detector, never cross-checked. The three columns below are a HUMAN's judgement of whether the
-- detector was right, written by a moderator in the board's UI. They answer different questions and
-- move independently — the common row is `actioned = false` (the detector left the account alone)
-- carrying `verdict = 'tp'` (and it was right to flag it). Nothing reads one to infer the other, and
-- recording a verdict must leave `actioned`/`action` untouched.
--
-- NULL `verdict` means UNRULED, which is the state every finding starts in and the state a run's
-- "still to review" count is derived from. It is not a fourth verdict: `skip` is the moderator
-- saying "I looked and I am not calling it", which is a decision, and an unruled row is not.
ALTER TABLE abuse_detection_finding ADD COLUMN IF NOT EXISTS verdict text;
-- Who ruled, and when. Overwritten on a re-ruling — a moderator correcting a mistake must leave the
-- record showing the CURRENT ruling and who stands behind it, not the first one.
ALTER TABLE abuse_detection_finding ADD COLUMN IF NOT EXISTS verdict_by text;
ALTER TABLE abuse_detection_finding ADD COLUMN IF NOT EXISTS verdict_at timestamptz;
-- 🔴 The producer's cluster key: findings the detector believes are ONE actor, ruled once instead of
-- N times. NULL for an ungrouped finding, which is most of them. Scoped to the run — the same key in
-- two runs is two separate decisions, because the cohort behind it is different — so every read and
-- write of it pairs `group_key` with `run_id`.
--
-- 🔴 IT MUST NOT CARRY ANYTHING THE FINDING'S OWN `reason` DOES NOT ALREADY SAY. The board is a wider
-- audience than the investigative tools, and a key is rendered; the producer therefore derives it
-- only from an attribute it has already written into the reason text.
ALTER TABLE abuse_detection_finding ADD COLUMN IF NOT EXISTS group_key text;

-- 🔴 EXACTLY THREE VERDICTS, OR NULL. Without this the column is free text, and a typo (`TP`, `fp `,
-- `false-positive`) becomes a fourth silent category that every count query drops on the floor — the
-- reassuring-zero failure the rest of this surface is built to refuse. `ADD CONSTRAINT` has no
-- `IF NOT EXISTS` in Postgres, so the existence test is explicit; the whole file must stay
-- re-runnable.
--
-- ⚠️ `verdict IS NULL OR` IS EXPLICITNESS, NOT ENFORCEMENT — stated because a comment claiming more
-- than the code delivers is worse than none. A CHECK passes whenever its expression evaluates to
-- NULL, so `verdict IN (…)` alone already admits an unruled row; deleting this clause changes no
-- behaviour, and a mutation test proves it (the whole suite stays green). It is kept because the
-- reader of a constraint should not have to know that rule to see that NULL is legal here. What a
-- test CAN catch is the opposite edit — `verdict IS NOT NULL AND verdict IN (…)`, which would make
-- every finding unwritable — and that is what the "accepts NULL" case guards.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'abuse_detection_finding'::regclass
       AND conname = 'abuse_detection_finding_verdict_valid'
  ) THEN
    ALTER TABLE abuse_detection_finding
      ADD CONSTRAINT abuse_detection_finding_verdict_valid
      CHECK (verdict IS NULL OR verdict IN ('tp', 'fp', 'skip'));
  END IF;
END
$$;

-- No index on `verdict` or `group_key`, deliberately. Both are only ever read WITHIN one run — the
-- unruled count is `WHERE run_id = $1`, and a group ruling is `WHERE run_id = $1 AND group_key = $2`
-- — so `abuse_detection_finding_run_idx` above already selects the rows, and a report carries at
-- most MAX_FINDINGS_PER_REPORT of them. A second index here would be write cost for no read.
