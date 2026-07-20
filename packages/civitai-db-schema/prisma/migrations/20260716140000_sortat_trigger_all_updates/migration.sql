-- Image.sortAt — widen the BEFORE trigger to fire on EVERY Image write.
--
-- Amendment to 20260716130000_image_sort_at_triggers. That migration scoped the
-- BEFORE trigger to `UPDATE OF "scannedAt", "postId"`. There is deliberately NO
-- backfill of the historical rows (Zuri, 2026-07-16: 88.1% of ~105M rows hold a
-- stale default-now() sortAt ⇒ a ~92M-row rewrite / 200-400GB WAL — cancelled).
--
-- WHY ALL-UPDATES: sortAt is NOT NULL, so those ~92M stale rows cannot be rescued
-- by a COALESCE(NEW."sortAt", …) fallback in the downstream bitdex sync trigger —
-- it would read and emit the stale value as sortAtUnix. With a column-listed
-- trigger, a stale row's sortAt is only repaired if it happens to receive a
-- scannedAt/postId write; an nsfwLevel-only edit (say) would fire the sync trigger
-- with the stale column intact and emit GARBAGE to BitDex. Recomputing NEW.sortAt
-- on ANY Image write makes the column correct-on-write: whatever touches the row
-- first repairs its sortAt before the sync emission reads it.
--
-- Idempotency / no fight: the Post fan-out UPDATE (sortAt, updatedAt) now also
-- fires this BEFORE trigger. At fan-out time the Post row already holds the new
-- publishedAt (it is an AFTER trigger on Post), so set_image_sort_at() recomputes
-- the IDENTICAL GREATEST value the fan-out's SET clause used and leaves updatedAt
-- untouched. No recursion — a BEFORE trigger only mutates NEW in place, issuing no
-- new UPDATE. Rejected alternative: dropping the fan-out's sortAt write and
-- computing sortAtUnix purely in the sync emission would MISS publish changes —
-- the Post subselect evaluates identically for OLD and NEW at fire time, so the
-- sync trigger's OLD≠NEW change-detection never sees the publish.
--
-- COST: the Post PK subselect in set_image_sort_at() now runs on EVERY Image
-- UPDATE (nsfwLevel, tags, reactions, …), not just publishes. This is exactly what
-- W3's [PR-M2] steady-state latency gate must measure at prod write rate.
--
-- Mirrors packages/civitai-db-schema/prisma/programmability/image_post_triggers.sql
-- (re-applied every `db:program`); repeated here so a manual apply installs it.
--
-- MANUAL APPLY ONLY (main civitai DB does NOT auto-apply Prisma migrations).
-- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE on the hot 105M "Image"
-- table (catalog-only, no rewrite, but blocks/queues behind writes) — run off-peak
-- with `SET lock_timeout = '5s';` and retry. Idempotent / re-runnable.

CREATE OR REPLACE TRIGGER image_sort_at_before
  BEFORE INSERT OR UPDATE
  ON "Image"
  FOR EACH ROW
EXECUTE FUNCTION set_image_sort_at();
