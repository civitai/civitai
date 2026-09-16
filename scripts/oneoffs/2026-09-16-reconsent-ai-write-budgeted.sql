-- Re-consent `ai:write:budgeted` after the scope's meaning widened.
--
-- 🔴 APPLIED BY HAND, BY A HUMAN, PER ENVIRONMENT. Nothing in this repo runs
-- this file, and nothing should. It is not a Prisma migration and must not
-- become one.
--
-- ============================================================================
-- WHY
-- ============================================================================
-- App Blocks moved to full orchestrator access with no per-app allowlist. The
-- `ai:write:budgeted` consent sentence used to read:
--
--     "Submit generations with a per-call Buzz cap"
--
-- The per-call cap half is still true. "Generations" is not: the scope now
-- reaches every orchestrator step type that is not platform-internal, which
-- includes hosted LLM inference and model training. Everyone holding a live
-- grant agreed to the narrower sentence, so the grants have to be re-taken.
--
-- ============================================================================
-- 🔴 ORDERING — THE ONE WAY TO GET THIS WRONG
-- ============================================================================
-- RUN THIS ONLY AFTER the new consent copy is CONFIRMED LIVE in the environment
-- you are pointing at. Revoking first means every affected user is re-prompted
-- with the OLD sentence, silently re-consents to the thing you were trying to
-- stop them being bound by, and both halves of the change still look done.
--
-- Confirm the live copy first: open an app that declares the scope and read the
-- consent modal. The new sentence names language models and training
-- explicitly; the old one says "Submit generations".
--
-- ============================================================================
-- WHAT IT DOES, AND WHAT IT DOES NOT
-- ============================================================================
-- `getGrantedScopes` and `getConsentBuzzBudget` both short-circuit on
-- `!row || row.revokedAt`, so a revoked row already yields an EMPTY grant set:
-- the user's token carries no `ai:write:budgeted` and reaches no spend path.
-- That read path is live and fail-closed today; only a writer was missing, and
-- this file is that writer, once.
--
-- It does NOT build a user-facing withdraw affordance. That is a separate,
-- still-open piece of work with its own design questions (JWT invalidation,
-- revoke-vs-uninstall, live-session behaviour, re-grant, where the affordance
-- lives). Do not treat this file as having answered any of them.
--
-- Re-granting un-revokes cleanly through the existing upsert
-- (`data: { grantedScopes: merged, version, revokedAt: null }`), so a user who
-- accepts the new copy is restored with no operator action.
--
-- ⚠️ A VERSION BUMP IS NOT AN ALTERNATIVE TO THIS. `app_user_scope_grants` has a
-- `version` column, but the consent lookup keys on the compound unique
-- (user_id, app_block_id) and NEVER READS `version` — the upsert only stamps it
-- while MERGING `granted_scopes`. Shipping a new app version re-prompts for
-- nothing.

BEGIN;

-- ---------------------------------------------------------------------------
-- STEP 1 — COUNT FIRST, and write the number down.
--
-- 🔴 Do not take the population from any document. It was 15 live grants across
-- 15 distinct users when this file was written; it can only have grown, and the
-- verification in step 3 compares against whatever you see HERE, not against a
-- number someone recorded earlier.
-- ---------------------------------------------------------------------------
SELECT
  count(*)                        AS live_grants_to_revoke,
  count(DISTINCT user_id)         AS distinct_users,
  count(DISTINCT app_block_id)    AS distinct_apps
FROM app_user_scope_grants
WHERE 'ai:write:budgeted' = ANY (granted_scopes)
  AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 2 — REVOKE.
--
-- Scoped deliberately narrowly:
--   * only grants that actually name this scope — a grant for other scopes is
--     untouched, because its consent text did not change;
--   * only grants that are still live — `revoked_at IS NULL` keeps this
--     re-runnable and stops a second run from overwriting the first run's
--     timestamps with a later one.
-- ---------------------------------------------------------------------------
UPDATE app_user_scope_grants
SET revoked_at = now()
WHERE 'ai:write:budgeted' = ANY (granted_scopes)
  AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 3 — VERIFY BEFORE COMMITTING.
--
-- `still_live` MUST be 0. `revoked_now` must equal the `live_grants_to_revoke`
-- you read in step 1 (plus anything already revoked by an earlier run, which is
-- why it is reported separately rather than compared blind).
--
-- If `still_live` is not 0, ROLLBACK and find out why before retrying.
-- ---------------------------------------------------------------------------
SELECT
  count(*) FILTER (WHERE revoked_at IS NULL)     AS still_live,
  count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked_total
FROM app_user_scope_grants
WHERE 'ai:write:budgeted' = ANY (granted_scopes);

-- Replace with ROLLBACK if step 3 did not read still_live = 0.
COMMIT;

-- ============================================================================
-- ROLLBACK, if the widening is reverted
-- ============================================================================
-- The operation is symmetric. Restoring the grants is:
--
--   UPDATE app_user_scope_grants
--   SET revoked_at = NULL
--   WHERE 'ai:write:budgeted' = ANY (granted_scopes)
--     AND revoked_at IS NOT NULL;
--
-- 🔴 That is only safe while this file's revoke is the ONLY thing that has ever
-- written `revoked_at` on this table (it was: 0 of 33 rows carried a non-null
-- value before this change). Once a real user-facing withdraw path exists, the
-- statement above would un-revoke consent that users withdrew THEMSELVES.
-- Re-check that assumption before running it, and narrow it by `revoked_at`
-- timestamp if it no longer holds.
