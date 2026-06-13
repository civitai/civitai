-- A6 (audit HIGH / design-gaps C2): per-user scope-grant consent.
--
-- BEFORE this table, scope authorisation for a block instance came ONLY from
-- the shared app_blocks.approved_scopes column. A mod-approve of a new version
-- that adds a scope (e.g. ai:write:budgeted) immediately minted that scope for
-- EVERY existing install on the next render — including version-pinned ones —
-- with no per-user consent and no re-prompt (silent scope escalation).
--
-- app_user_scope_grants is the per-(user, app_block) consent ledger. Token
-- issuance (block-tokens/index.ts) now intersects the manifest/approved scope
-- set with the user's granted_scopes; any scope the manifest requests but the
-- user has not granted is WITHHELD from the minted token and surfaced back to
-- the host as a `needs_consent` signal. A grant row is written at install /
-- subscribe time (the implicit first-consent), and re-consent adds the new
-- scopes to granted_scopes (carrying the version forward).
--
-- `granted_scopes` is a TEXT[] of block-scope strings (the same vocabulary as
-- app_blocks.approved_scopes / manifest.scopes — e.g. 'models:read:self'),
-- NOT an OAuth bitmask, so the intersection at mint time is a direct set op.
--
-- `version` records the app version the most recent grant was made against, so
-- a later "what did the user consent to" surface can show staleness. It is
-- informational for the consent flow — the authoritative gate is the
-- granted_scopes set, not the version.
--
-- `revoked_at` (NULL = active) lets a future per-scope revoke flip a grant off
-- without deleting the row's audit trail. A non-NULL revoked_at means the mint
-- path treats granted_scopes as empty (every scope withheld → needs_consent).

CREATE TABLE "app_user_scope_grants" (
    "id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "app_block_id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "granted_scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "granted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "app_user_scope_grants_pkey" PRIMARY KEY ("id")
);

-- One grant row per (user, app_block). Install/subscribe upserts onto this
-- pair; the partial-version + scope detail lives in the columns. The unique
-- constraint makes the mint-time lookup a single findUnique and makes the
-- grant write an idempotent upsert.
CREATE UNIQUE INDEX "app_user_scope_grants_user_app_uniq"
  ON "app_user_scope_grants"("user_id", "app_block_id");

-- FK to User: a GDPR delete cascades the consent ledger away.
ALTER TABLE "app_user_scope_grants"
  ADD CONSTRAINT "app_user_scope_grants_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- FK to app_blocks: a deleted block drops its grants.
ALTER TABLE "app_user_scope_grants"
  ADD CONSTRAINT "app_user_scope_grants_app_block_id_fkey"
  FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
