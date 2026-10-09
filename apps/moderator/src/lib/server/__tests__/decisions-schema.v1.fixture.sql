-- Human rulings recorded on the moderator app's `/decisions` page.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `abuse_detection_*`.
--
-- 🔴 APPLIED BY HAND, in each environment — no runner, no auto-apply on deploy. Until it is applied the
-- page still renders every item read-only and says the table is missing.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/decisions/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Applied as
-- `postgres` the table is postgres-owned, the app cannot read it, and the page reports `no-grant`.
-- Recovery is ownership, not a grant (one statement per object):
--   ALTER TABLE    decision_resolution        OWNER TO internal_tools;
--   ALTER SEQUENCE decision_resolution_id_seq OWNER TO internal_tools;
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- 🔴 APPEND-ONLY. One row per ruling; the CURRENT ruling on an item is its latest row per
-- (source, item_key, sub_key). Nothing UPDATEs or DELETEs here: a re-ruling is a new row, so the
-- record keeps what every human said and what they were looking at when they said it.
CREATE TABLE IF NOT EXISTS decision_resolution (
  id             bigserial   PRIMARY KEY,
  -- Widened per source, together with DECISION_SOURCES in `src/lib/decision-rulings.ts`.
  source         text        NOT NULL,
  -- support-ticket: the issue group's key.
  item_key       text        NOT NULL,
  -- support-ticket: the ticket id for a per-member label; '' for a ruling on the whole group.
  sub_key        text        NOT NULL DEFAULT '',
  -- support-ticket: the router version. Labels are version-scoped — the same ticket can sit in a
  -- different group under another version.
  source_version text        NOT NULL,
  -- The area tag at ruling time (support-ticket: the group's topic slug), read from the source, not
  -- from the form.
  area           text,
  ruling         text        NOT NULL,
  -- duplicate_of: the survivor item's key.
  target_key     text,
  -- escalate: the area/team it is escalated to.
  escalate_to    text,
  note           text,
  -- 🔴 The moderator's user ID, never a username — a username is reassignable.
  ruled_by       integer     NOT NULL,
  ruled_at       timestamptz NOT NULL DEFAULT now(),
  apply_state    text        NOT NULL DEFAULT 'n/a',
  -- 🔴 What the source said about the item at ruling time (probabilities, member count, spec hash).
  -- The source keeps moving after a ruling — members arrive, tickets are re-routed — so without
  -- this a label would detach from the evidence it was given on.
  shown          jsonb       NOT NULL
);

-- (source, item_key, sub_key) → latest first: exactly the "current ruling" read.
CREATE INDEX IF NOT EXISTS decision_resolution_item
  ON decision_resolution (source, item_key, sub_key, ruled_at DESC);

-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each is guarded by name to keep the file re-runnable.
-- The value sets MUST equal the tuples in `src/lib/decision-rulings.ts`;
-- `src/lib/server/__tests__/decision-resolution.schema.test.ts` applies this file and checks both
-- directions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_source_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_source_valid
      CHECK (source IN ('support-ticket'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_ruling_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_ruling_valid
      CHECK (ruling IN ('correct', 'split', 'duplicate_of', 'park', 'escalate', 'skip',
                        'belongs', 'not_belongs', 'unsure'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_apply_state_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_apply_state_valid
      CHECK (apply_state IN ('n/a', 'pending', 'applied', 'rejected'));
  END IF;

  -- Member labels carry a sub_key; group rulings do not. A label with no ticket, or a group ruling
  -- pinned to one, would be read back under the wrong item.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_scope_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_scope_valid
      CHECK ((ruling IN ('belongs', 'not_belongs', 'unsure')) = (sub_key <> ''));
  END IF;

  -- A duplicate names its survivor; nothing else names one.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_target_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_target_valid
      CHECK ((ruling = 'duplicate_of') = (target_key IS NOT NULL AND target_key <> ''));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_escalate_valid') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_escalate_valid
      CHECK (ruling <> 'escalate' OR (escalate_to IS NOT NULL AND escalate_to <> ''));
  END IF;

  -- 🔴 Rulings that ask the source to change something are never born 'n/a', and labels are never
  -- anything else. 'applied'/'rejected' are reachable only from 'pending', by whatever later applies
  -- them — never by this app in v1.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'decision_resolution'::regclass AND conname = 'decision_resolution_apply_matches_ruling') THEN
    ALTER TABLE decision_resolution ADD CONSTRAINT decision_resolution_apply_matches_ruling
      CHECK ((ruling IN ('duplicate_of', 'park')) = (apply_state <> 'n/a'));
  END IF;
END
$$;
