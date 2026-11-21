-- A staff lock on a version's licence fee: while set, only a moderator may change the fee, its type or
-- its settlement currency. Staff set it by hand, with the fee.
--
-- Apply BEFORE the deploy: the regenerated client selects "licensingFeeLocked". A constant default on
-- PostgreSQL 11+ is a catalog-only change, so the table is not rewritten.
ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "licensingFeeLocked" BOOLEAN NOT NULL DEFAULT false;
