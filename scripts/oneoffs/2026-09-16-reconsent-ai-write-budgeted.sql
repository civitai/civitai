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
-- The per-call cap half is still true. "Generations" is not: the scope reaches
-- hosted LLM inference (`chatCompletion`, registered and live), which is not a
-- generation in any sense a reader of that sentence would have understood.
-- Everyone holding a live grant agreed to the narrower sentence, so the grants
-- have to be re-taken.
--
-- 🔴 THE NEW SENTENCE NAMES ONLY WHAT IS REACHABLE TODAY, ON PURPOSE. It does
-- NOT promise model training: training is allowed by the denylist but no wire
-- arm accepts it and no implemented billing mode can carry it. Re-consenting to
-- a capability that does not exist BANKS permission for a widening that has not
-- shipped, and nothing would re-prompt when it does — which is the silent scope
-- escalation this table exists to prevent. When a NEW capability becomes
-- reachable, the sentence changes and the grants are re-taken AGAIN. That is
-- the intended cost, not an oversight.
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
-- `!row || row.revokedAt`, so a revoked row yields an EMPTY grant set at the
-- next MINT: the token issued after this runs carries no `ai:write:budgeted`.
--
-- 🔴 "FAIL-CLOSED" IS NOT TRUE OF ALREADY-MINTED TOKENS, AND THE GAP OPENS
-- WIDER BEFORE IT CLOSES. An earlier draft of this header claimed the revoke
-- immediately "reaches no spend path". It does not:
--
--   1. Block tokens are JWTs with NO revocation list and NO jti check
--      (`block-token.service.ts`). Default lifetime is 900s (300s for
--      settings-scoped, 4h for dev). So for up to ~15 MINUTES after this runs,
--      a token minted just before it still carries the scope.
--   2. 🔴 WORSE, AND COUNTER-INTUITIVE: the revoke removes the user's OWN CAP
--      FIRST. `getConsentBuzzBudget` returns null for a revoked row, and
--      `reserveBlockBuzzSpendForClaims` treats a null budget as "no consent
--      reservation" — it falls back to the PLATFORM ceiling
--      (`BLOCK_BUZZ_CAP_PER_DAY`) alone. A user who had set, say, 500 Buzz/day
--      on an app has that lifted for the remainder of their token's life.
--
-- Concretely: user U holds a live token and a 500/day budget on app A. You run
-- this at T. Between T and T+15min, A can spend U's Buzz against the platform
-- allowance rather than 500, and nothing errors.
--
-- This is bounded and small, and it is the accepted cost of having no revoke
-- path — but run this when spend is quiet rather than at peak, and do not
-- describe the window as closed the moment the UPDATE commits.
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
--
-- ⚠️ THE SCOPING IS NARROW ACROSS ROWS, NOT WITHIN ONE. `revoked_at` is a ROW
-- column and `getGrantedScopes` returns an empty Set for a revoked row, so any
-- OTHER scopes granted on the same row — `user:read:self`, `models:read:self`,
-- `apps:storage:*` — go with it until the user re-consents. Expect support
-- reports of an app "forgetting" something unrelated to Buzz.
--
-- Re-granting restores them cleanly: `recordScopeGrant` MERGES `granted_scopes`
-- and clears `revoked_at`. A stored per-day budget also survives, because the
-- consent modal omits the budget key when the spend switch is off rather than
-- writing a zero.
-- ---------------------------------------------------------------------------
UPDATE app_user_scope_grants
SET revoked_at = now()
WHERE 'ai:write:budgeted' = ANY (granted_scopes)
  AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- STEP 3 — VERIFY BEFORE COMMITTING.
--
-- `still_live` MUST be 0.
--
-- `revoked_by_this_run` is what to compare against `live_grants_to_revoke` from
-- step 1 — they must be EQUAL. It is reported separately from
-- `revoked_before_this_run` precisely so a prior run's rows do not inflate the
-- number you are checking. (An earlier draft told you to compare a column named
-- `revoked_now`, which this query never emitted, against a conflated total. It
-- was uncheckable as written.)
--
-- The realistic way `still_live` is non-zero: a new grant was committed between
-- STEP 2 and here. That is exactly what this gate is for.
-- ---------------------------------------------------------------------------
-- `now()` is transaction_timestamp() and is CONSTANT across this transaction,
-- so it is the same value STEP 2 wrote. (`statement_timestamp()` would NOT be —
-- it advances per statement and would report 0 for this run's own rows.)
SELECT
  count(*) FILTER (WHERE revoked_at IS NULL)                  AS still_live,
  count(*) FILTER (WHERE revoked_at = now())                  AS revoked_by_this_run,
  count(*) FILTER (WHERE revoked_at IS NOT NULL
                     AND revoked_at <> now())                 AS revoked_before_this_run
FROM app_user_scope_grants
WHERE 'ai:write:budgeted' = ANY (granted_scopes);

-- 🔴 DO NOT RUN THIS FILE WITH `psql -f`. It is written to be stepped through.
-- Under `-f` every statement executes and the COMMIT below lands BEFORE any
-- human has read STEP 3 — which makes the verification gate decorative.
--
-- Run it interactively: paste STEP 1, read the count; paste STEP 2; paste
-- STEP 3; and only then type COMMIT (or ROLLBACK) yourself. The COMMIT is left
-- here, commented, as documentation of the intended end state rather than as an
-- executable line.
--
-- COMMIT;   -- ← type this by hand, only after STEP 3 reads still_live = 0

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
