-- ============================================================
-- App Blocks: the GitHub Actions run an App submit came from
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are applied by hand (see CLAUDE.md -> Database):
-- there is no `prisma migrate deploy` path. A human runs this file against the main civitai
-- database, dev first, then production.
--
-- 🔴 APPLY IT BEFORE THE DEPLOY, and in any case before turning on the
-- `app-blocks-oidc-verified-submit` flag. The code does tolerate the columns being absent: all
-- eight are marked no-type in `schema.full.prisma`, so the generated Prisma client never names
-- them in a default SELECT / RETURNING (the P2022 outage `20260817210000` and `20260823120000`
-- describe cannot happen through them), and every read and write is raw SQL in
-- `src/server/services/blocks/actions-run-source.service.ts`, which treats a missing column
-- (42703) as "none recorded". But with the flag on and these columns missing, every verified run
-- is checked and then NOT stored, and the submit answers `actionsRunSourceRecorded: false`.
--
-- WHAT THE COLUMNS HOLD. When a submit carries a GitHub Actions OIDC token and the flag is on, the
-- server verifies the token against GitHub's published keys (issuer, the pinned audience, expiry,
-- one-use jti, a tag push whose tag is the manifest version) and stores these claims from it:
--
--   actions_run_repository             `owner/repo`
--   actions_run_repository_id          GitHub's numeric repository id (survives a rename)
--   actions_run_repository_owner_id    GitHub's numeric owner id (survives a rename)
--   actions_run_sha                    the 40-hex commit the run was triggered for
--   actions_run_ref                    the full ref, `refs/tags/<tag>`
--   actions_run_workflow_ref           the workflow file and ref that ran
--   actions_run_repository_visibility  `public` | `private` | `internal`, at run time
--   actions_run_id                     the Actions run id
--
-- 🔴 FACTS ABOUT THE SUBMITTING RUN, NOT ABOUT THE BUNDLE. The developer's own workflow builds
-- and uploads the bundle, so these say "submitted by a GitHub Actions run of <repo> at <tag>
-- (<sha>)" and nothing more: not that the bundle was built from that commit, and not a security
-- review.
--
-- 🔴 A SEPARATE TRUST LEVEL FROM `source_commit` / `source_dirty` (20260817210000), which are
-- what the client CLAIMED, and from `forgejo_commit_sha`, which the platform writes on approve.
-- Never alias, default or fall back between any of them.
--
-- NULLABLE, NO DEFAULT, NO BACKFILL: NULL means no verified run (an older submit, a submit without
-- a token, or the flag off). No index: they are read per request by primary key, and per serving
-- version on the store page through `app_block_id` + `forgejo_commit_sha`.
--
-- Additive and idempotent (`IF NOT EXISTS`). Nullable with no default, so on PG 11+ each ADD COLUMN
-- is catalog-only (no table rewrite). It takes a brief ACCESS EXCLUSIVE lock on
-- `app_block_publish_requests`; `lock_timeout` makes it abort rather than queue behind a long
-- transaction. On `canceling statement due to lock timeout`, nothing was applied: re-run.
--
-- ROLLBACK: none needed for the code (it reads absent columns as "none recorded"). Dropping the
-- columns deletes the only record of which runs submitted which requests, so do not drop them to
-- roll back a deploy.

SET lock_timeout = '3s';

ALTER TABLE "app_block_publish_requests"
  ADD COLUMN IF NOT EXISTS "actions_run_repository" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_repository_id" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_repository_owner_id" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_sha" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_workflow_ref" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_repository_visibility" TEXT,
  ADD COLUMN IF NOT EXISTS "actions_run_id" TEXT;

-- VERIFY THE SCHEMA. `IF NOT EXISTS` reports success either way. Must return exactly eight rows,
-- all `is_nullable = YES`, `data_type = text`, `column_default` NULL:
--
--   SELECT column_name, is_nullable, data_type, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'app_block_publish_requests'
--     AND column_name LIKE 'actions_run_%'
--   ORDER BY column_name;
--
-- VERIFY THE BEHAVIOUR, after the deploy and with the flag on for the submitter: push a tag in an
-- app repo that uses the Action, then
--
--   SELECT id, slug, version, actions_run_repository, actions_run_ref, actions_run_sha,
--          actions_run_repository_visibility, source_commit
--   FROM app_block_publish_requests
--   ORDER BY submitted_at DESC LIMIT 5;
--
-- The new row must carry the repository, `refs/tags/<tag>` and the 40-hex sha. A row submitted
-- without a token legitimately carries NULL in all eight.
