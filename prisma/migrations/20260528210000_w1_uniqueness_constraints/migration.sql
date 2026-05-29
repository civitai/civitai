-- ============================================================
-- App Blocks W1 v0 audit follow-up — C-3 + C-4 DB constraints
-- ============================================================
-- Closes two read-then-write race windows surfaced by the audit
-- (claudedocs/app-blocks-w1-v0-audit-2026-05-28.md):
--
--   C-3: two concurrent first-version approves for the same slug both
--        passed their app-layer "is first version?" check and inserted
--        distinct app_blocks rows. The existing (app_id, block_id) unique
--        constraint did NOT protect because each approve minted a fresh
--        app_id. The C-2 fix (deterministic appblk-<slug> id) blunts this
--        at the OauthClient layer, but a DB constraint on block_id is
--        belt-and-suspenders: anywhere block_id collides — not just via
--        approve — fails fast.
--
--   C-4: two concurrent submitVersion calls for the same slug both
--        passed their app-layer "no pending request?" check and inserted
--        distinct publish_request rows. A partial unique index on
--        (slug) WHERE status='pending' enforces "at most one pending
--        request per slug" at the DB.
--
-- Pre-flight (run before applying):
--   SELECT block_id, count(*) FROM app_blocks
--     GROUP BY block_id HAVING count(*) > 1;
--   SELECT slug, count(*) FROM app_block_publish_requests
--     WHERE status='pending' GROUP BY slug HAVING count(*) > 1;
-- Both must be empty. Verified 0 rows on cnpg-cluster-nvme0 prod
-- 2026-05-28 before this migration was committed.
--
-- Manual application (per CLAUDE.md gotcha #14):
--   kubectl exec -i -n cnpg-database cnpg-cluster-nvme0-N -- psql \
--     -U postgres -d civitai -v ON_ERROR_STOP=1 --single-transaction \
--     < prisma/migrations/20260528210000_w1_uniqueness_constraints/migration.sql

-- C-3: one app_blocks row per block_id, full stop.
ALTER TABLE "app_blocks"
  ADD CONSTRAINT "app_blocks_block_id_unique" UNIQUE ("block_id");

-- C-4: at most one pending publish_request per slug. Partial index lets
-- approved/rejected/withdrawn rows accumulate without conflict.
CREATE UNIQUE INDEX "app_block_publish_requests_one_pending_per_slug"
  ON "app_block_publish_requests" ("slug")
  WHERE "status" = 'pending';
