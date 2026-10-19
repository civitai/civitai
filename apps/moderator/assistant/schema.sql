-- The mod assistant's storage: chats, one audit row per turn, playbooks with their versions, and the
-- tool requests the assistant files when it cannot answer something.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `abuse_detection_*` and
-- `decision_resolution`.
--
-- 🔴 APPLIED BY HAND, in each environment — no runner, no auto-apply on deploy. Until it is applied the
-- `/assistant` pages say the tables are missing and run nothing. Apply it BEFORE the release that
-- ships the pages.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/assistant/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Applied as
-- `postgres` the tables are postgres-owned and the app cannot read them. Recovery is ownership, one
-- statement per object (`ALTER TABLE assistant_chat OWNER TO internal_tools;` and so on).
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- Moderators are recorded by USER ID throughout, never by username: a username is reassignable, and
-- an audit row must keep naming the person who acted.

CREATE TABLE IF NOT EXISTS assistant_chat (
  id            bigserial   PRIMARY KEY,
  moderator_id  integer     NOT NULL,
  title         text        NOT NULL,
  -- What the chat was opened on, from an Investigate button. Context for the first prompt; nothing
  -- joins on them, and the account or report may since have been deleted.
  seed_user_id   integer,
  seed_report_id integer,
  -- Keys the labels that stand in for addresses a moderator may not read, so a label is stable for the
  -- whole chat and cannot be worked back to an address without it. Never sent to the browser.
  mask_salt     text        NOT NULL DEFAULT gen_random_uuid()::text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz
);

-- A moderator's chat list, newest activity first. Chats are private to their moderator.
CREATE INDEX IF NOT EXISTS assistant_chat_moderator_idx
  ON assistant_chat (moderator_id, updated_at DESC);

-- 🔴 THE AUDIT. One row per turn: who asked, what, every tool call with its arguments and row counts,
-- what came back, which model, how many tokens. The chat transcript is read from these rows too, so
-- there is no second record of a conversation that could disagree with the audit.
--
-- APPEND-ONLY apart from finishing the row it started: a turn is inserted as `running` and updated
-- once, to its outcome. Nothing deletes from here; archiving a chat hides it from its moderator's
-- list and leaves every turn readable on `/assistant/audit`.
CREATE TABLE IF NOT EXISTS assistant_turn (
  id                bigserial   PRIMARY KEY,
  chat_id           bigint      NOT NULL REFERENCES assistant_chat (id),
  moderator_id      integer     NOT NULL,
  prompt            text        NOT NULL,
  -- The playbook the moderator ran this turn with, at the version they ran.
  playbook_slug     text,
  playbook_version  integer,
  status            text        NOT NULL DEFAULT 'running',
  -- [{ name, args, rows, truncated, ms, error }] in call order.
  tool_calls        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- Every record a tool returned that an answer may cite: [{ ref: 'user:123', href, label }].
  sources           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  answer            text,
  -- Citations in `answer` that no tool returned in this chat. Rendered as unverified.
  unverified        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  error             text,
  model             text        NOT NULL,
  prompt_tokens     integer     NOT NULL DEFAULT 0,
  completion_tokens integer     NOT NULL DEFAULT 0,
  total_tokens      integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,

  CONSTRAINT assistant_turn_status_valid
    CHECK (status IN ('running', 'done', 'error', 'capped'))
);

CREATE INDEX IF NOT EXISTS assistant_turn_chat_idx ON assistant_turn (chat_id, id);
-- One answer in flight per MODERATOR. The daily token cap is checked before a turn starts, so
-- concurrent turns would each pass it; one at a time bounds the overshoot to one model call. (It also
-- stops two questions in one chat each replaying a history missing the other.) The second is refused
-- (23505) rather than run.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_turn_one_running_idx
  ON assistant_turn (moderator_id) WHERE status = 'running';
-- The daily token cap sums one moderator's turns since midnight; the audit lists newest first.
CREATE INDEX IF NOT EXISTS assistant_turn_moderator_idx
  ON assistant_turn (moderator_id, created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_turn_created_idx ON assistant_turn (created_at DESC);

CREATE TABLE IF NOT EXISTS assistant_playbook (
  id          serial      PRIMARY KEY,
  -- The name the assistant and the prompt box use. Never renamed: turns record it.
  slug        text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,

  CONSTRAINT assistant_playbook_slug_valid CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);

-- 🔴 APPEND-ONLY VERSIONS. An edit is a new row; the CURRENT text of a playbook is its highest
-- `accepted` version. A version the assistant drafted starts `proposed` and changes nothing until a
-- moderator accepts it — so text that arrived through a conversation (which can carry quoted user
-- content) never reaches the instructions of a later investigation on its own.
CREATE TABLE IF NOT EXISTS assistant_playbook_version (
  playbook_id  integer     NOT NULL REFERENCES assistant_playbook (id),
  version      integer     NOT NULL,
  title        text        NOT NULL,
  -- One line: when to use it. The assistant sees every playbook's summary, and the body of the one it
  -- reads.
  summary      text        NOT NULL,
  body         text        NOT NULL,
  status       text        NOT NULL,
  note         text,
  -- The moderator who wrote or accepted it; for a proposal, the moderator whose chat drafted it.
  author_id    integer     NOT NULL,
  proposed_by_assistant boolean NOT NULL DEFAULT false,
  -- The turn that drafted a proposal, for the audit trail.
  source_turn_id bigint,
  created_at   timestamptz NOT NULL DEFAULT now(),
  reviewed_by  integer,
  reviewed_at  timestamptz,

  PRIMARY KEY (playbook_id, version),
  CONSTRAINT assistant_playbook_version_status_valid
    CHECK (status IN ('accepted', 'proposed', 'rejected'))
);

-- 🔴 What the assistant asks its maintainers for: "I needed a tool that does X". Read by the standing
-- seat that owns the assistant, which answers in `response` and moves `status`.
CREATE TABLE IF NOT EXISTS assistant_tool_request (
  id            bigserial   PRIMARY KEY,
  chat_id       bigint      NOT NULL REFERENCES assistant_chat (id),
  turn_id       bigint      REFERENCES assistant_turn (id),
  moderator_id  integer     NOT NULL,
  need          text        NOT NULL,
  reason        text        NOT NULL,
  example       text,
  -- The moderator's prompts and the assistant's answers up to the request, so whoever builds the tool
  -- sees the case that prompted it.
  conversation  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  status        text        NOT NULL DEFAULT 'open',
  response      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,

  CONSTRAINT assistant_tool_request_status_valid
    CHECK (status IN ('open', 'planned', 'built', 'declined'))
);

CREATE INDEX IF NOT EXISTS assistant_tool_request_created_idx
  ON assistant_tool_request (created_at DESC);
