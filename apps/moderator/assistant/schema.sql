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

-- Added after the table shipped, so an ALTER rather than a column above: re-running this file adds it
-- to an existing table. The model's reasoning for the turn, every round in order, shown collapsed
-- beside the answer. Null when the model returned none.
ALTER TABLE assistant_turn ADD COLUMN IF NOT EXISTS reasoning text;

CREATE INDEX IF NOT EXISTS assistant_turn_chat_idx ON assistant_turn (chat_id, id);
-- One answer in flight per MODERATOR. The daily caps are checked before a turn starts, so
-- concurrent turns would each pass it; one at a time bounds the overshoot to one model call. (It also
-- stops two questions in one chat each replaying a history missing the other.) The second is refused
-- (23505) rather than run.
CREATE UNIQUE INDEX IF NOT EXISTS assistant_turn_one_running_idx
  ON assistant_turn (moderator_id) WHERE status = 'running';
-- The daily caps sum one moderator's turns since midnight; the audit lists newest first.
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

-- What each finished turn cost, in USD, at the higher of OpenRouter's live price and the release's list
-- price for its model (`price_source` says whether a live price was read). The daily dollar cap sums
-- it. Null on turns from before it existed and on turns that never finished; the cap charges those
-- their recorded tokens at the most expensive listed model's price.
ALTER TABLE assistant_turn ADD COLUMN IF NOT EXISTS cost_usd numeric;
ALTER TABLE assistant_turn ADD COLUMN IF NOT EXISTS price_source text;

-- 🔴 The daily dollar cap per role and per moderator, set on `/admin/spend-caps`. A moderator's cap is
-- their own row if they have one (a $0 row turns the assistant off for them whatever their roles say),
-- else the highest cap among their roles, else the default in the code. `subject` is a role name
-- (`moderator:...`) or a user ID as text.
CREATE TABLE IF NOT EXISTS assistant_spend_cap (
  scope        text          NOT NULL,
  subject      text          NOT NULL,
  usd_per_day  numeric(8, 2) NOT NULL,
  updated_by   integer       NOT NULL,
  updated_at   timestamptz   NOT NULL DEFAULT now(),

  PRIMARY KEY (scope, subject)
);

-- 🔴 APPEND-ONLY. One row per cap change, written in the same transaction as the change and before
-- it, so a change that cannot be recorded does not happen. `before`/`after` null: no row.
CREATE TABLE IF NOT EXISTS assistant_spend_cap_change (
  id          bigserial     PRIMARY KEY,
  actor_id    integer       NOT NULL,
  scope       text          NOT NULL,
  subject     text          NOT NULL,
  usd_before  numeric(8, 2),
  usd_after   numeric(8, 2),
  reason      text,
  at          timestamptz   NOT NULL DEFAULT now()
);

-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each is guarded by name to keep the file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_turn'::regclass AND conname = 'assistant_turn_price_source_valid') THEN
    ALTER TABLE assistant_turn ADD CONSTRAINT assistant_turn_price_source_valid
      CHECK (price_source IN ('live', 'list'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_spend_cap'::regclass AND conname = 'assistant_spend_cap_scope_valid') THEN
    ALTER TABLE assistant_spend_cap ADD CONSTRAINT assistant_spend_cap_scope_valid
      CHECK (scope IN ('role', 'user'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_spend_cap'::regclass AND conname = 'assistant_spend_cap_usd_valid') THEN
    ALTER TABLE assistant_spend_cap ADD CONSTRAINT assistant_spend_cap_usd_valid
      CHECK (usd_per_day >= 0);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'assistant_spend_cap_change'::regclass AND conname = 'assistant_spend_cap_change_scope_valid') THEN
    ALTER TABLE assistant_spend_cap_change ADD CONSTRAINT assistant_spend_cap_change_scope_valid
      CHECK (scope IN ('role', 'user'));
  END IF;
END
$$;
