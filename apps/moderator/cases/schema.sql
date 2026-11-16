-- The case engine's tables: process definitions (versioned), cases, their targets, events, outgoing
-- notices and parties. Typed by hand in `src/lib/server/cases/cases-tables.ts` (`withTables`), not
-- pulled; `cases-schema.pglite.test.ts` applies this file and checks the two agree.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `page_access_change`.
--
-- 🔴 APPLIED BY HAND, in each environment, AS THE APPLICATION ROLE (`internal_tools`), so the app owns
-- the tables. Applied as `postgres` they are postgres-owned and the app cannot write them.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/cases/schema.sql
--
-- Access: the definition tables hold no personal data. The other five do, or point at people who are
-- party to a claim: names, emails, phone numbers, postal addresses, organisations, the accounts a claim
-- names, and the messages sent to them. `internal_tools_ro`, the read-only login agents use, gets SELECT
-- on the two definition tables and nothing on the other five. PUBLIC gets nothing on any of them. Created
-- the role after this file? Re-run the whole file.
--
-- Read back after applying (one row). Expected: 7 | 7 | 2 | t | 84
--   SELECT count(*) FILTER (WHERE c.relkind = 'r') AS tables,
--          count(*) FILTER (WHERE c.relkind = 'r' AND pg_get_userbyid(c.relowner) = 'internal_tools') AS owned,
--          (SELECT count(*) FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid
--            WHERE i.indisunique AND ic.relname IN ('case_notice_idem_key', 'case_record_public_ref_key')) AS unique_keys,
--          (SELECT bool_and(
--             CASE WHEN t IN ('process_definition', 'process_definition_version')
--               THEN COALESCE(has_table_privilege(r.oid, to_regclass(t), 'SELECT'), false)
--               ELSE COALESCE(NOT has_any_column_privilege(r.oid, to_regclass(t), 'SELECT'), false)
--                 AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE g.oid <> r.oid AND pg_has_role(r.oid, g.oid, 'MEMBER')
--                   AND has_any_column_privilege(g.oid, to_regclass(t), 'SELECT'))
--             END
--             AND NOT EXISTS (SELECT 1 FROM pg_roles g WHERE (g.oid = r.oid OR pg_has_role(r.oid, g.oid, 'MEMBER'))
--               AND (COALESCE(has_any_column_privilege(g.oid, to_regclass(t), 'INSERT, UPDATE, REFERENCES'), true)
--                 OR COALESCE(has_table_privilege(g.oid, to_regclass(t), 'DELETE, TRUNCATE, TRIGGER'), true))))
--             FROM pg_roles r, unnest(ARRAY['process_definition', 'process_definition_version', 'case_record',
--               'case_target', 'case_event', 'case_notice', 'case_party']) t
--            WHERE r.rolname = 'internal_tools_ro') AS ro_ok,
--          (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN
--            ('process_definition', 'process_definition_version', 'case_record', 'case_target',
--             'case_event', 'case_notice', 'case_party')) AS columns
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--   WHERE n.nspname = 'public' AND c.relname IN ('process_definition', 'process_definition_version',
--     'case_record', 'case_target', 'case_event', 'case_notice', 'case_party');
-- Before the apply it prints 0 | 0 | 0 | f | 0. `ro_ok` is t only when the read-only role can read the
-- two definition tables, can't read any of the other five, and can't write any of the seven: not
-- directly, through PUBLIC, or through a role it can SET ROLE to. Null means the role doesn't exist yet.
-- f after a re-run means a grant this file can't revoke (a role membership, PUBLIC from another owner,
-- or pg_read_all_data): find it with `\dp case_record` and `\du internal_tools_ro`, and ask an infra
-- owner to remove it. `src/lib/server/cases/pii-lockdown.ts` is the same check for the app to run.
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- One row per process (a takedown notice type, a review request, ...). `current_version_id` is the version
-- new cases pin; a case keeps the version it was opened under.
CREATE TABLE IF NOT EXISTS process_definition (
  id                 bigserial   PRIMARY KEY,
  key                text        NOT NULL UNIQUE,
  current_version_id bigint,
  enabled            boolean     NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- 🔴 APPEND-ONLY. A version is never edited; a change is a new row.
CREATE TABLE IF NOT EXISTS process_definition_version (
  id            bigserial   PRIMARY KEY,
  definition_id bigint      NOT NULL REFERENCES process_definition (id),
  definition    jsonb       NOT NULL,
  -- The user ID, never a username.
  created_by_id integer     NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  note          text
);

CREATE INDEX IF NOT EXISTS process_definition_version_definition_idx
  ON process_definition_version (definition_id, id DESC);

-- `case` is reserved, hence `case_record`.
CREATE TABLE IF NOT EXISTS case_record (
  id                    bigserial   PRIMARY KEY,
  -- The reference people see and quote: TD-<yy>-<6 base32>, made in app code.
  public_ref            text        NOT NULL UNIQUE,
  process_key           text        NOT NULL,
  -- NULL for imported cases, whose messages are kept verbatim rather than rendered from a definition.
  definition_version_id bigint      REFERENCES process_definition_version (id),
  -- Checked in app code against the pinned definition's states.
  state                 text        NOT NULL,
  source                text        NOT NULL,
  received_at           timestamptz NOT NULL,
  valid_at              timestamptz,
  due_at                timestamptz,
  warn_at               timestamptz,
  restore_earliest_at   timestamptz,
  restore_latest_at     timestamptz,
  minor_flag            boolean     NOT NULL DEFAULT false,
  is_test               boolean     NOT NULL DEFAULT false,
  related_case_id       bigint      REFERENCES case_record (id),
  submitter_user_id     integer,
  -- Personal data: name, email, phone, postal address, organisation and role, as a DMCA notice
  -- requires (512(c)(3)) and as a submitter gives them.
  submitter             jsonb       NOT NULL DEFAULT '{}',
  -- Each statement's text version, typed signature, time and IP hash.
  statements            jsonb       NOT NULL DEFAULT '[]',
  details               jsonb       NOT NULL DEFAULT '{}',
  email_confirmed_at    timestamptz,
  handled_by_id         integer,
  decision              text,
  decided_at            timestamptz,
  retain_until          timestamptz,
  -- Set by a one-off import; an import is undone by this id while none of its notices has been sent.
  import_batch_id       text,
  -- The client's id for one submission, so a retried submit cannot open a second case.
  submission_id         text        UNIQUE,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_record_state_due_idx ON case_record (state, due_at);
CREATE INDEX IF NOT EXISTS case_record_process_received_idx ON case_record (process_key, received_at);
CREATE INDEX IF NOT EXISTS case_record_submitter_email_idx ON case_record (lower(submitter ->> 'email'));
CREATE INDEX IF NOT EXISTS case_record_import_batch_idx ON case_record (import_batch_id)
  WHERE import_batch_id IS NOT NULL;

-- One item a case is about. Entity ids point into the main database; there is no foreign key across
-- databases.
CREATE TABLE IF NOT EXISTS case_target (
  id               bigserial   PRIMARY KEY,
  case_id          bigint      NOT NULL REFERENCES case_record (id),
  url              text        NOT NULL,
  entity_type      text,
  entity_id        integer,
  uploader_user_id integer,
  p_hash           text,
  hash_algo        text,
  category         text,
  state            text        NOT NULL DEFAULT 'Pending',
  strike_id        integer,
  kept_until       timestamptz,
  acted_at         timestamptz,
  acted_by_id      integer
);

CREATE INDEX IF NOT EXISTS case_target_case_idx ON case_target (case_id);
CREATE INDEX IF NOT EXISTS case_target_entity_idx ON case_target (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS case_target_uploader_idx ON case_target (uploader_user_id, state);

-- 🔴 APPEND-ONLY. A removal runs in the main database, so it is bracketed here by an
-- `action_started` row before and an `action_done` row after; a started with no done is unconfirmed.
CREATE TABLE IF NOT EXISTS case_event (
  id             bigserial   PRIMARY KEY,
  case_id        bigint      NOT NULL REFERENCES case_record (id),
  case_target_id bigint      REFERENCES case_target (id),
  at             timestamptz NOT NULL DEFAULT now(),
  actor_id       integer,
  type           text        NOT NULL,
  -- A reminder's threshold, so each one is written once.
  threshold      text,
  -- A removal attempt's number, so a retry is a new attempt and never a second copy of one.
  attempt        integer,
  data           jsonb       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS case_event_case_idx ON case_event (case_id, at);
CREATE UNIQUE INDEX IF NOT EXISTS case_event_threshold_key ON case_event (case_id, type, threshold)
  WHERE threshold IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS case_event_attempt_key ON case_event (case_target_id, type, attempt)
  WHERE attempt IS NOT NULL;

-- One outgoing message. Its row is claimed (`sending`) before the send and settled after it.
CREATE TABLE IF NOT EXISTS case_notice (
  id               bigserial   PRIMARY KEY,
  case_id          bigint      NOT NULL REFERENCES case_record (id),
  -- The target's id, or 0 for a message about the whole case, so the key below holds without NULLs.
  target_key       bigint      NOT NULL,
  notice_id        text        NOT NULL,
  recipient_role   text        NOT NULL,
  -- The address it goes to, as resolved when the row was made: an imported message arrives with its
  -- address, not an account. Personal data. Erasing a case after `retain_until` sets this and
  -- `body_snapshot` (which quotes it) to NULL; `address_hash` and `message_id` stay as the record.
  recipient_address text,
  address_hash     text        NOT NULL,
  status           text        NOT NULL DEFAULT 'pending',
  message_id       text,
  attempted_at     timestamptz,
  sent_at          timestamptz,
  -- An error class or code, never a message: messages can carry addresses.
  error            text,
  -- The exact text that was previewed, and is sent.
  subject_snapshot text        NOT NULL,
  body_snapshot    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT case_notice_idem_key UNIQUE (case_id, target_key, notice_id, recipient_role)
);

CREATE INDEX IF NOT EXISTS case_notice_status_idx ON case_notice (status, attempted_at);

-- Someone with a side in a case. A party sees only its own part: a claimant every target of its case, an
-- uploader the targets it uploaded.
CREATE TABLE IF NOT EXISTS case_party (
  id           bigserial   PRIMARY KEY,
  case_id      bigint      NOT NULL REFERENCES case_record (id),
  role         text        NOT NULL,
  user_id      integer,
  address_hash text,
  -- When a moderator verified an agent acting for an uploader; until then it sees nothing.
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS case_party_case_idx ON case_party (case_id);
CREATE UNIQUE INDEX IF NOT EXISTS case_party_user_key ON case_party (case_id, role, user_id)
  WHERE user_id IS NOT NULL;

-- Dropped and added on every run, so a changed value set reaches every environment on its next re-run.
-- 🔴 Each pair is one DO block, which is atomic: psql -f commits statement by statement, so a bare DROP
-- followed by an ADD that fails (rows that break the new rule) would leave the table with no constraint.
DO $$
BEGIN
  ALTER TABLE case_record DROP CONSTRAINT IF EXISTS case_record_source_check;
  ALTER TABLE case_record ADD CONSTRAINT case_record_source_check
    CHECK (source IN ('form', 'email', 'report', 'import'));
END $$;

DO $$
BEGIN
  ALTER TABLE case_target DROP CONSTRAINT IF EXISTS case_target_state_check;
  ALTER TABLE case_target ADD CONSTRAINT case_target_state_check
    CHECK (state IN ('Pending', 'Removed', 'Held', 'Kept', 'Restored'));
END $$;

DO $$
BEGIN
  ALTER TABLE case_notice DROP CONSTRAINT IF EXISTS case_notice_status_check;
  ALTER TABLE case_notice ADD CONSTRAINT case_notice_status_check
    CHECK (status IN ('pending', 'sending', 'sent', 'failed'));
END $$;

DO $$
BEGIN
  ALTER TABLE case_party DROP CONSTRAINT IF EXISTS case_party_role_check;
  ALTER TABLE case_party ADD CONSTRAINT case_party_role_check
    CHECK (role IN ('claimant', 'uploader', 'agent-for-uploader'));
END $$;

-- An attempt is always of one target's removal, so the attempt key below can't be dodged with a NULL.
DO $$
BEGIN
  ALTER TABLE case_event DROP CONSTRAINT IF EXISTS case_event_attempt_target_check;
  ALTER TABLE case_event ADD CONSTRAINT case_event_attempt_target_check
    CHECK (attempt IS NULL OR case_target_id IS NOT NULL);
END $$;

DO $$
BEGIN
  ALTER TABLE process_definition DROP CONSTRAINT IF EXISTS process_definition_current_version_fkey;
  ALTER TABLE process_definition ADD CONSTRAINT process_definition_current_version_fkey
    FOREIGN KEY (current_version_id) REFERENCES process_definition_version (id);
END $$;

REVOKE ALL ON process_definition, process_definition_version, case_record, case_target, case_event,
  case_notice, case_party FROM PUBLIC;
REVOKE ALL ON SEQUENCE process_definition_id_seq, process_definition_version_id_seq, case_record_id_seq,
  case_target_id_seq, case_event_id_seq, case_notice_id_seq, case_party_id_seq FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'internal_tools_ro') THEN
    -- Everything first, so a write or a broad grant made earlier doesn't survive the re-run.
    REVOKE ALL ON process_definition, process_definition_version, case_record, case_target, case_event,
      case_notice, case_party FROM internal_tools_ro;
    REVOKE ALL ON SEQUENCE process_definition_id_seq, process_definition_version_id_seq, case_record_id_seq,
      case_target_id_seq, case_event_id_seq, case_notice_id_seq, case_party_id_seq FROM internal_tools_ro;
    GRANT SELECT ON process_definition, process_definition_version TO internal_tools_ro;
  ELSE
    RAISE WARNING 'role internal_tools_ro does not exist: grants skipped; create it, then re-run this file';
  END IF;
END $$;
