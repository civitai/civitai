-- ============================================================
-- Hosted agent sandbox — durable session state (M2.5)
-- ============================================================
-- NOT AUTO-APPLIED. Migrations in this repo are run by hand — see CLAUDE.md -> Database.
-- There is no `prisma migrate deploy` path and `_prisma_migrations` is not the source of
-- truth; a HUMAN applies the statements below per environment. Apply to BOTH:
--   1. the production primary (the live civitai DB)
--   2. the dev clone
--
-- Idempotent: every CREATE is IF NOT EXISTS and the two FKs are added only when absent,
-- so a re-run on an environment that already has the table is a no-op. This matters
-- because the apply is a manual step repeated across two environments — the same reason
-- `20260811170000_rekey_app_collaborators_step_b_create_listing_keyed` gives for its own.
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

CREATE TABLE IF NOT EXISTS "app_dev_sandbox" (
    "id"                   TEXT           NOT NULL,
    "user_id"              INTEGER        NOT NULL,
    "block_id"             TEXT           NOT NULL,
    "app_block_id"         TEXT,
    "status"               TEXT           NOT NULL DEFAULT 'provisioning',
    "status_detail"        TEXT,
    "volume_claim_name"    TEXT,
    "transcript_key"       TEXT,
    "last_tunnel_host"     TEXT,
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

-- 🔴 NOT a purge mechanism, and nothing here should be read as one. `deleteUser` is a
-- SOFT delete — `dbWrite.user.update({ data: { deletedAt } })` in user.service.ts, which
-- states twice in its own comments that "the FK cascade never fires ... because this is a
-- SOFT delete". So this CASCADE does not fire on account deletion, and a deleted user's
-- sandbox row, transcript object and volume all SURVIVE it. Reclaiming those needs an
-- explicit hook on the delete/ban paths; it does not exist yet and this FK is not a
-- substitute for it. The CASCADE is here only so a genuine hard delete of a User row
-- cannot leave a dangling child.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_dev_sandbox_user_id_fkey') THEN
    ALTER TABLE "app_dev_sandbox"
      ADD CONSTRAINT "app_dev_sandbox_user_id_fkey"
      FOREIGN KEY ("user_id") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- SET NULL, NOT CASCADE or RESTRICT: deleting the block must leave this row reachable by
-- the janitor, because there is still a volume to delete. A cascade would orphan storage
-- with no handle left to it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_dev_sandbox_app_block_id_fkey') THEN
    ALTER TABLE "app_dev_sandbox"
      ADD CONSTRAINT "app_dev_sandbox_app_block_id_fkey"
      FOREIGN KEY ("app_block_id") REFERENCES "app_blocks"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Idle-pause sweep: status='active' AND last_active_at older than the idle window.
CREATE INDEX IF NOT EXISTS "app_dev_sandbox_idle_sweep_idx"
    ON "app_dev_sandbox" ("status", "last_active_at");

-- "my sandboxes" reads.
CREATE INDEX IF NOT EXISTS "app_dev_sandbox_user_idx"
    ON "app_dev_sandbox" ("user_id", "status");

-- 🔴 At most ONE non-reaped sandbox per (user, app). Not expressible in Prisma (it carries
-- a WHERE), mirroring "app_block_publish_requests_one_pending_per_slug". LOAD-BEARING, not
-- hygiene: the provision path relies on its P2002 to close the read-then-write race, so
-- two concurrent resume clicks cannot each provision a volume and leak the one that loses.
--
-- 🔴 `reaped` IS THE ONLY EXCLUSION, AND `failed` IS DELIBERATELY *NOT* ONE. A `failed`
-- sandbox still HOLDS ITS VOLUME, so treating it as terminal here would have been a
-- contradiction with two bad branches: nothing would ever reclaim it (the retention sweep
-- below is paused-only and a never-paused row carries a NULL deadline), and a user could
-- accumulate unbounded `failed` rows for one pair, each holding a volume. Keeping `failed`
-- inside the uniqueness scope means it occupies the single live slot until it is either
-- resumed or carried through the ordinary pause -> retention path, which is the path that
-- honours the warn-before-delete guard. `reaped` has already released its storage, so it
-- is the only state that is genuinely done.
CREATE UNIQUE INDEX IF NOT EXISTS "app_dev_sandbox_one_live_per_user_block"
    ON "app_dev_sandbox" ("user_id", "block_id")
    WHERE "status" <> 'reaped';

-- Retention sweep. Covers BOTH states that retain a volume and carry a deadline, so a
-- `failed` sandbox is reclaimable on the same clock and under the same `warned_at` guard
-- as a paused one.
CREATE INDEX IF NOT EXISTS "app_dev_sandbox_retention_sweep_idx"
    ON "app_dev_sandbox" ("retention_expires_at")
    WHERE "status" IN ('paused', 'failed');
