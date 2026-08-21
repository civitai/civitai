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
-- Idempotent: safe to re-run.

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
-- Keeps the HIGHEST id — last writer wins, matching what the runtime upsert does. Keeping the
-- lowest would make the migration and the running code disagree about which duplicate is current.
CREATE UNIQUE INDEX IF NOT EXISTS abuse_detection_run_detector_started_key
  ON abuse_detection_run (detector, started_at);
-- Superseded by the unique index above, which covers the same leading column. Dropped rather than
-- left behind: an environment that ran an earlier copy of this file still carries it, and a
-- redundant index is pure write cost on every insert.
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
