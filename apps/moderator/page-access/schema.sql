-- The history of who may open which moderator-app page or hold which action grant: one row per path per
-- change, written by `/admin`'s save and by `POST /api/admin/page-access`. The grants themselves live in
-- the main database's "AppPageAccess", which keeps only the last writer.
--
-- Lives in the `internal_tools` database (MODERATOR_DATABASE_URL), beside `assistant_*`.
--
-- 🔴 APPLIED BY HAND, in each environment — no runner, no auto-apply on deploy. Apply it BEFORE the
-- release that ships the code: both write paths refuse to change a grant they cannot record, so until
-- this table exists `/admin` cannot save.
--
--   psql "$MODERATOR_DATABASE_URL" -f apps/moderator/page-access/schema.sql
--
-- 🔴 AS THE APPLICATION ROLE (`internal_tools`), which is what that URL connects as. Applied as
-- `postgres` the table is postgres-owned and the app cannot write it. Recovery is ownership:
--   ALTER TABLE    page_access_change        OWNER TO internal_tools;
--   ALTER SEQUENCE page_access_change_id_seq OWNER TO internal_tools;
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- 🔴 APPEND-ONLY, except `outcome`. A row is written `pending` BEFORE the grant (the two are in
-- different databases, so they cannot share a transaction), then set `applied` once the grant commits or
-- `refused` once it rolls back. A row left `pending` is unconfirmed: re-check the grant itself.
CREATE TABLE IF NOT EXISTS page_access_change (
  id           bigserial   PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  -- 🔴 The user ID, never a username — a username is reassignable.
  actor_id     integer     NOT NULL,
  via          text        NOT NULL,
  -- The approval the change was made under (a hub card id). Required from the API.
  gate_ref     text,
  -- A page path or a `grant:<permission>` key, as "AppPageAccess".path stores it.
  path         text        NOT NULL,
  roles_before text[]      NOT NULL,
  roles_after  text[]      NOT NULL,
  reason       text,
  outcome      text        NOT NULL DEFAULT 'pending'
);

-- What a `/admin` save did to roles it does not edit: stored roles from outside its catalogue it kept
-- (`roles_carried`), and retired ones of its own it dropped (`roles_dropped`). Both are also in
-- `roles_before`; kept apart so "who removed X" is answerable without the catalogue as it stood then.
-- Written by `/admin` only: an API change names its one role and leaves both empty, as do older rows.
ALTER TABLE page_access_change ADD COLUMN IF NOT EXISTS roles_carried text[] NOT NULL DEFAULT '{}';
ALTER TABLE page_access_change ADD COLUMN IF NOT EXISTS roles_dropped text[] NOT NULL DEFAULT '{}';

-- `ADD CONSTRAINT` has no `IF NOT EXISTS`, so each is guarded by name to keep the file re-runnable.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'page_access_change'::regclass AND conname = 'page_access_change_via_valid') THEN
    ALTER TABLE page_access_change ADD CONSTRAINT page_access_change_via_valid
      CHECK (via IN ('admin-page', 'api'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'page_access_change'::regclass AND conname = 'page_access_change_outcome_valid') THEN
    ALTER TABLE page_access_change ADD CONSTRAINT page_access_change_outcome_valid
      CHECK (outcome IN ('pending', 'applied', 'refused'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'page_access_change'::regclass AND conname = 'page_access_change_api_gated') THEN
    ALTER TABLE page_access_change ADD CONSTRAINT page_access_change_api_gated
      CHECK (via <> 'api' OR (gate_ref IS NOT NULL AND gate_ref ~ '\S'));
  END IF;
END
$$;
