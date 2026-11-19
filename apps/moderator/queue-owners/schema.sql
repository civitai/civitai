-- Who owns which moderator-app queue: the people accountable for keeping it covered, set on
-- `/admin/queue-owners`. Ownership is a separate axis from page access (who MAY open a queue) and from
-- claiming (there is none: reports are a shared pool). A queue is keyed by its page path, as the
-- `NAVIGATION` tree in `src/lib/server/access.ts` declares it; one row per owner, so a queue with no rows
-- has nobody covering it, which is exactly what the admin page exists to show.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `page_access_change`.
--
-- 🔴 APPLIED BY HAND, in each environment — no runner, no auto-apply on deploy. Apply it BEFORE the
-- release that ships the code. Until it exists the admin page says so and cannot save, and the dashboard
-- shows every queue with no My Tasks view.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/queue-owners/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Applied as
-- `postgres` the tables are postgres-owned and the app cannot write them. Recovery is ownership:
--   ALTER TABLE    queue_owner                OWNER TO internal_tools;
--   ALTER TABLE    queue_owner_change         OWNER TO internal_tools;
--   ALTER SEQUENCE queue_owner_change_id_seq  OWNER TO internal_tools;
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

CREATE TABLE IF NOT EXISTS queue_owner (
  -- A queue's page path, e.g. `/images/minor`.
  path         text        NOT NULL,
  -- 🔴 User IDs, never usernames — a username is reassignable.
  user_id      integer     NOT NULL,
  assigned_by  integer     NOT NULL,
  assigned_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (path, user_id)
);

-- The dashboard reads one moderator's queues on every load.
CREATE INDEX IF NOT EXISTS queue_owner_user_id_idx ON queue_owner (user_id);

-- 🔴 APPEND-ONLY. One row per queue per save, written in the same transaction as the change, so a
-- change that cannot be recorded does not happen.
CREATE TABLE IF NOT EXISTS queue_owner_change (
  id             bigserial   PRIMARY KEY,
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       integer     NOT NULL,
  path           text        NOT NULL,
  owners_before  integer[]   NOT NULL,
  owners_after   integer[]   NOT NULL
);
