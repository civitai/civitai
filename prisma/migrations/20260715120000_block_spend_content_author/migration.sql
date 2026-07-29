-- ============================================================
-- App Blocks — buzz SPEND attribution: published-content-author basis
-- ============================================================
-- Additive, nullable columns on block_spend_attribution so a block-
-- initiated generation can ALSO capture the USER who published the shared
-- content the generation ran on behalf of (the "content author"), not just
-- the app owner. This is the durable BASIS for a FUTURE creator payout to
-- content authors — it is TRACK-ONLY today (no payout/share logic reads
-- these columns yet).
--
-- FULLY GENERIC: there is no "generator" concept here. Any app whose users
-- publish cross-user shared content (per-app schema `app_<slug>.shared_kv`)
-- that drives generation spend can populate these columns. The mechanism is
-- the same for every app.
--
--   content_author_user_id  the User who authored the shared_kv row this
--                           generation ran on behalf of. Resolved SERVER-
--                           SIDE from `shared_content_key` against the
--                           calling app's own `app_<slug>.shared_kv`
--                           (author_user_id WHERE key = $1 AND hidden_at IS
--                           NULL) — NEVER a client-supplied author. NULL
--                           when: no key supplied, the row is missing /
--                           hidden, or the author is the spender (self) or
--                           the app owner (fail-open — see the service).
--   shared_content_key      the opaque shared-storage `key` the app supplied
--                           for this generation (bounded, app-owned). NULL
--                           when the app supplied none.
--
-- ⚠️ MANUAL-APPLY: committed for history, NOT auto-applied. A human applies
--    this to prod and the dev database out of band (the main civitai DB is
--    not on an auto-migrate path). Both columns are ADDITIVE + NULLABLE with
--    no default and NO backfill, so the apply is order-safe: it can land
--    before OR after the code that writes them deploys (there are zero readers
--    of these columns until a future payout slice ships). Existing rows stay
--    NULL.
--
-- content_author_user_id carries a nullable FK to User with ON DELETE SET
-- NULL (NOT the ON DELETE RESTRICT used by the mandatory user_id /
-- app_owner_user_id columns): a payout-basis reference must never block a
-- user account deletion, and losing the basis on deletion is acceptable.

ALTER TABLE "block_spend_attribution"
  ADD COLUMN "content_author_user_id" INTEGER,
  ADD COLUMN "shared_content_key"     TEXT;

ALTER TABLE "block_spend_attribution"
  ADD CONSTRAINT "block_spend_attribution_content_author_fkey"
    FOREIGN KEY ("content_author_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Future creator-payout access path: "everything credited to content author
-- X, newest first". Partial (only the populated rows) so it stays tiny while
-- the column is sparsely populated.
CREATE INDEX "bsa_content_author_idx"
  ON "block_spend_attribution" ("content_author_user_id", "attributed_at" DESC)
  WHERE "content_author_user_id" IS NOT NULL;
