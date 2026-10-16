-- Site appeal form: which queue a form-filed appeal belongs to, and what the form collected beyond
-- the message. NULL on every existing row and on every appeal filed from an in-app button.
--
-- MANUAL APPLY, per environment (dev, then prod), BEFORE the code that reads it deploys: Prisma
-- returns every scalar column, so a client that knows "category" fails every Appeal query on a
-- database without it, image appeals included.
--
-- Then apply the four index migrations after this one, in order, each on its own:
--   20261102120100_appeal_inapp_pending_key
--   20261102120200_appeal_category_pending_key
--   20261102120300_appeal_category_queue_idx
--   20261102120400_appeal_drop_old_pending_key
-- Until the last one runs, the old category-blind key makes a form appeal and an in-app appeal (or
-- an Account and an Other appeal) on the same entity collide, so the form stays mods-only until then.
--
-- Nullable with no default, so ADD COLUMN is a catalog change only (no rewrite).
SET lock_timeout = '3s';

CREATE TYPE "AppealCategory" AS ENUM ('Account', 'Article', 'Model', 'Other');

ALTER TABLE "Appeal"
  ADD COLUMN "category" "AppealCategory",
  ADD COLUMN "context" JSONB;
