-- When the scan label sweep finished deleting a copy. A claimed row ("withdrawnAt" set) without it is a
-- delete still in progress, or one whose sweep died; the sweep takes such a claim again after an hour.
--
-- Apply before the build that ships it: the sweep writes it. Rows withdrawn earlier have none and are
-- deleted once more, which is harmless.

ALTER TABLE "ScanLabelCopyObject" ADD COLUMN IF NOT EXISTS "removedAt" TIMESTAMPTZ(3);
