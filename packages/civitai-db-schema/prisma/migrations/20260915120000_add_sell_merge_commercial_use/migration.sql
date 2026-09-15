-- STEP 1 of 3, and it goes BEFORE the deploy. Read the note below before reordering it.
--
-- The usual rule for an additive Prisma enum is deploy-first, because Prisma throws on READ
-- for a row carrying a label the running client does not know. That rule assumes nothing
-- writes the new value until the deploy lands. Here the deploy itself writes it: the upload
-- form defaults `allowCommercialUse` to every permission, 'SellMerge' included, so the first
-- creator to submit a model after the deploy inserts the label. If the type does not have it
-- yet, that insert is rejected and model creation fails for everyone until this runs.
--
-- Running it first is safe in the other direction: no build writes 'SellMerge' until the
-- deploy, so no row can carry it, so no running client can read one.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block: run this statement alone.

ALTER TYPE "CommercialUse" ADD VALUE IF NOT EXISTS 'SellMerge';
