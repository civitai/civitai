-- W13 App Blocks — richer per-action audit detail on the block-token action audit.
--
-- The run-frame "Permissions & activity" view (#3156) shows one row per scoped
-- block-token call. Today a mutation row can only render `scope · endpoint ·
-- status`. This migration adds a nullable `detail` JSON column so an impactful
-- MUTATION (tip / workflow submit / settings update / storage set|delete|
-- increment) can carry a stable, structured action payload — a stable `action`
-- code plus minimal subject refs (ids, amounts, keys), NEVER a pre-rendered
-- string — that the view resolves to a human sentence at render time. Passive
-- READS write NO detail; their label is derived from `scope` at render time.
--
-- Additive + backward-compatible: nullable, no default → no backfill, no table
-- rewrite. Every existing row keeps `detail = NULL` and renders via the historical
-- `scope · endpoint · status` fallback. The payload stores IDS (not display
-- names), so a row never rots when a name changes.
--
-- MANUAL APPLY ONLY: the main civitai DB (CNPG nvme0) does NOT auto-apply Prisma
-- migrations. Apply this SQL by hand to the target env; _prisma_migrations is not
-- the source of truth here. Safe to run in or out of a transaction (metadata-only).

ALTER TABLE "block_scope_invocations"
  ADD COLUMN IF NOT EXISTS "detail" JSONB;
