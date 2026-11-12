-- Image.nsfwAxes: an image's rating axes as one-hot bit groups in one nullable integer. The layout
-- and the write rules are in src/server/services/image-nsfw-axes.ts. NULL means not rated by an
-- axis-capable rater; there is no backfill.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Apply it before turning on the `image-axis-shadow-write` flag. Until it exists the
-- scan writes its verdict without the axes. The column is `@no-type` (raw SQL only), so Prisma never
-- selects it and the code may deploy before or after this runs.
--
-- A nullable column with no default is a catalog-only change: no table rewrite, existing rows
-- untouched. Nothing indexes it. The short lock_timeout keeps a waiting ALTER from queueing
-- every query on "Image" behind it; on a timeout nothing is applied, so re-run it. Idempotent.

BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "nsfwAxes" INTEGER;
COMMIT;
