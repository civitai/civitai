-- Apply BEFORE the deploy, not after. The usual deploy-first rule assumes nothing writes the new
-- label until the deploy lands; here the deploy writes it immediately -- the upload form defaults
-- to every permission, and Prisma applies the schema @default client-side on any model.create
-- that omits the field -- so without this the insert is rejected and model creation fails.
--
-- A rolling deploy still has previous-build pods reading rows new pods wrote; Prisma deserializes
-- the enum for a whole result set, so list queries fail intermittently until it completes.
--
-- src/pages/api/admin/temp/backfill-trained-model-permissions.ts also writes this label. Do not
-- run it before this migration, or during a rolling deploy.
--
-- The backfill that gives existing models the new permission is deliberately not in this commit
-- and must not be applied with it: it would write the label while the old build is still serving.
--
-- Run alone: ADD VALUE is transactional, but the value is unusable in the same transaction, and a
-- multi-statement psql -c is one implicit transaction. Separate -c flags are safe.

ALTER TYPE "CommercialUse" ADD VALUE IF NOT EXISTS 'SellMerge';
