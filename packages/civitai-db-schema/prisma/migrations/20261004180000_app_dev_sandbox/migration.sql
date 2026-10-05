-- ============================================================
-- Hosted agent sandbox — durable session state (M2.5)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are run by hand — see CLAUDE.md -> Database.
-- There is no `prisma migrate deploy` path and `_prisma_migrations` is not the source of
-- truth; a HUMAN applies the statements below per environment. Apply to BOTH:
--   1. the production primary (the live civitai DB)
--   2. the dev clone
--
-- ------------------------------------------------------------
-- ORDERING: SAFE TO APPLY AHEAD OF THE CODE, IN EITHER ORDER
-- ------------------------------------------------------------
-- 🔴 THIS IS DELIBERATELY *UNLIKE* `20261001170000_app_listing_visibility`, AND THE
-- DIFFERENCE IS WORTH READING BEFORE ASSUMING THE SAME HARD ORDERING APPLIES.
--
-- That migration ADDED A COLUMN to an existing model, so Prisma's generated
-- `INSERT/UPDATE ... RETURNING <every scalar the MODEL declares>` named the new column on
-- every read of that model — deploying the code first raised 42703 on live traffic. This
-- migration adds a WHOLE NEW TABLE and changes no existing table, so no existing query's
-- RETURNING list can name anything here. The two orderings are therefore:
--
--   * Migration applied, code not shipped  -> NO EFFECT AT ALL. A table with no reader
--     and no writer. This is the intended ordering.
--   * Code shipped, migration not applied  -> NOT no-effect: any read or write of
--     `app_dev_sandbox` raises P2021 (relation does not exist). So the code is safe to
--     ship ahead ONLY while it sits behind an off-by-default flag, the way the dev tunnel
--     shipped dark behind `app-blocks-dev-tunnel`. THE FLAG FLIP IS THE STEP THAT
--     REQUIRES THIS MIGRATION TO BE APPLIED FIRST.
--
-- Fully ADDITIVE: one new table, no change to any existing table, no new enum TYPE, no
-- backfill, no destructive step. Rollback is `DROP TABLE "app_dev_sandbox"`, safe for as
-- long as nothing writes to it.
--
-- `status` is TEXT bounded by a CHECK rather than a Prisma enum — see the model docblock
-- and the root CLAUDE.md ("Adding an enum value: DEPLOY FIRST"). A Prisma enum fails on
-- READ in a client that does not know the label; a CHECK fails on WRITE, loudly, in the
-- code that introduced it. Adding a state later means dropping and re-adding this CHECK.
--
-- Indexes are created plain, NOT CONCURRENTLY, deliberately: the table is brand new and
-- empty, so a plain CREATE INDEX is instantaneous and locks an object no session can see
-- yet, while CONCURRENTLY cannot run inside a transaction block and would make this
-- script less atomic for no benefit.
-- ============================================================

CREATE TABLE "app_dev_sandbox" (
    "id"                   TEXT           NOT NULL,
    "user_id"              INTEGER        NOT NULL,
    "block_id"             TEXT           NOT NULL,
    "app_block_id"         TEXT,
    "status"               TEXT           NOT NULL DEFAULT 'provisioning',
    "status_detail"        TEXT,
    "volume_claim_name"    TEXT,
    "volume_size_bytes"    BIGINT,
    "transcript_key"       TEXT,
    "last_tunnel_host"     TEXT,
    "spend_instance_id"    TEXT,
    "spend_cap_buzz"       INTEGER        NOT NULL,
    "created_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"           TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at"       TIMESTAMPTZ(6),
    "paused_at"            TIMESTAMPTZ(6),
    "retention_expires_at" TIMESTAMPTZ(6),
    "warned_at"            TIMESTAMPTZ(6),
    "reaped_at"            TIMESTAMPTZ(6),
    CONSTRAINT "app_dev_sandbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_dev_sandbox_status_check" CHECK (
        "status" IN ('provisioning', 'active', 'paused', 'resuming', 'reaped', 'failed')
    )
);

-- CASCADE: an account deletion takes the row with it. The volume is reclaimed by the
-- orphan-resource sweep, which keys on "a sandbox PVC with no non-terminal row".
ALTER TABLE "app_dev_sandbox"
    ADD CONSTRAINT "app_dev_sandbox_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- SET NULL, NOT CASCADE or RESTRICT: deleting the block must leave this row reachable by
-- the janitor, because there is still a volume to delete. A cascade would orphan storage
-- with no handle left to it.
ALTER TABLE "app_dev_sandbox"
    ADD CONSTRAINT "app_dev_sandbox_app_block_id_fkey"
    FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Idle-pause sweep: status='active' AND last_active_at older than the idle window.
CREATE INDEX "app_dev_sandbox_idle_sweep_idx"
    ON "app_dev_sandbox" ("status", "last_active_at");

-- "my sandboxes" reads.
CREATE INDEX "app_dev_sandbox_user_idx"
    ON "app_dev_sandbox" ("user_id", "status");

-- 🔴 At most ONE non-terminal sandbox per (user, app). Not expressible in Prisma (it
-- carries a WHERE), mirroring "app_block_publish_requests_one_pending_per_slug". This is
-- LOAD-BEARING, not hygiene: the provision path relies on its P2002 to close the
-- read-then-write race, so two concurrent resume clicks cannot each provision a volume
-- and leak the one that loses.
CREATE UNIQUE INDEX "app_dev_sandbox_one_live_per_user_block"
    ON "app_dev_sandbox" ("user_id", "block_id")
    WHERE "status" NOT IN ('reaped', 'failed');

-- Retention sweep: status='paused' AND retention_expires_at <= now(). Partial, because
-- only paused rows ever carry a retention deadline.
CREATE INDEX "app_dev_sandbox_retention_sweep_idx"
    ON "app_dev_sandbox" ("retention_expires_at")
    WHERE "status" = 'paused';
