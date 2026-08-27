-- 🔴 APPLY MANUALLY, OUTSIDE A TRANSACTION (psql WITHOUT --single-transaction).
-- The CREATE INDEX CONCURRENTLY at the end cannot run inside one. Every statement here is
-- rerunnable, so a partial apply can simply be re-run from the top — with one exception: if
-- the concurrent build is interrupted it leaves an INVALID index, which IF NOT EXISTS skips
-- rather than repairs. Drop it first in that case:
--   DROP INDEX CONCURRENTLY IF EXISTS "ModelVersion_modelId_nsfw_idx";

-- ModelVersion.nsfw — a version whose NAME is NSFW, independent of its images.
--
-- A version's nsfwLevel is derived from the owner's first 20 posted images, so there is
-- nowhere on the version to store a name-based verdict that survives the next recompute.
-- This column is an INPUT to that derivation instead (see updateModelVersionNsfwLevels),
-- which is exactly how Model.nsfw already behaves — and why ModelVersion needs no
-- lockedProperties column: a recompute cannot clobber a flag it reads as its own input.
--
-- Inert on arrival: DEFAULT FALSE, and its only writer — version-name moderation — selects
-- nothing until the curated term list is seeded.

ALTER TABLE "ModelVersion" ADD COLUMN IF NOT EXISTS "nsfw" BOOLEAN NOT NULL DEFAULT FALSE;

-- Teach the version trigger about the new column.
--
-- Without this the flag never takes effect: the update-nsfw-levels cron drains "JobQueue"
-- and does not scan for stale rows, and update-model-version-nsfw-levels only revisits
-- versions sitting at nsfwLevel 0 — so an already-rated version is not a fallback.
--
-- IS DISTINCT FROM, and firing in BOTH directions, are load-bearing. The same shape on
-- "Model" left versions stamped at the NSFW level after a true->false flip, which froze the
-- model's bit_or rollup at that level indefinitely; see
-- 20260519120000_fix_model_nsfw_flip_version_cascade.
--
-- Only the version is enqueued. getModelVersionConnectedEntities derives the parent model
-- from it, and updateNsfwLevels rolls models up after versions within the same tick.
--
-- Kept in sync with prisma/programmability/nsfw_level_update_triggers.sql.
CREATE OR REPLACE FUNCTION update_model_version_nsfw_level()
RETURNS TRIGGER AS $model_version_nsfw_level$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM create_job_queue_record(OLD."modelId", 'Model', 'UpdateNsfwLevel');
    RETURN NULL;
  END IF;

  IF (NEW.status = 'Published' AND OLD.status != 'Published') THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;

  IF (NEW."nsfw" IS DISTINCT FROM OLD."nsfw") THEN
    PERFORM create_job_queue_record(NEW.id, 'ModelVersion', 'UpdateNsfwLevel');
  END IF;

  RETURN NULL;
END;
$model_version_nsfw_level$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER model_version_nsfw_level_change
AFTER UPDATE OF "status", "nsfw" OR DELETE ON "ModelVersion"
FOR EACH ROW
EXECUTE FUNCTION update_model_version_nsfw_level();

-- A version under a system-owned model must never carry the name flag.
--
-- The derivation has no branch for a system-owned model that is not flagged: the CASE falls
-- through to NULL, the update's `!=` guard is never true, and the row keeps whatever level it
-- had. So setting the flag there is a ONE-WAY door — clearing it leaves the version stamped at
-- the NSFW level permanently, and that then rolls into its parent model. There is no agreed
-- level to recompute such a version back to, so the trap is closed at the write instead.
--
-- INSERT as well as UPDATE: the whole reason this is in the database is the writers that are
-- not the adapter — a hand-run backfill or a moderator tool can INSERT a version with the flag
-- already set, and an UPDATE-only guard never sees it. Once the row exists in that state no
-- later UPDATE OF "nsfw" is needed to keep it, so there is no second chance to catch it.
--
-- Enforced in the database, not in application code. The live writer (the version-name
-- moderation adapter) excludes system-owned models in its own WHERE, but a guard that only
-- lived there would not see a hand-run backfill or a moderator tool — and this is a trap with
-- no way back out.
CREATE OR REPLACE FUNCTION reject_system_model_version_nsfw()
RETURNS TRIGGER AS $reject_system_mv_nsfw$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Model" m WHERE m.id = NEW."modelId" AND m."userId" = -1
  ) THEN
    RAISE EXCEPTION
      'ModelVersion.nsfw cannot be set on a system-owned model (modelVersionId %, modelId %)',
      NEW.id, NEW."modelId";
  END IF;
  RETURN NEW;
END;
$reject_system_mv_nsfw$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER model_version_nsfw_system_guard
BEFORE INSERT OR UPDATE OF "nsfw" ON "ModelVersion"
FOR EACH ROW
WHEN (NEW."nsfw")
EXECUTE FUNCTION reject_system_model_version_nsfw();

-- Partial: the flagged set is a small fraction of the table and the only queries that need
-- an index ask for the true side (find the flagged versions under a model / across a sweep).
-- The rollup's `NOT nsfw` is the majority side and scans regardless.
--
-- Keyed on "modelId", not on "nsfw": the predicate already restricts every entry to the true
-- side, so keying on that column stores a constant, the index degenerates to an unordered tid
-- list, and the planner ignores it for the per-model lookup entirely. "modelId" is the same
-- width and serves both that lookup and an ordered sweep.
--
-- Not declared in schema.full.prisma: Prisma cannot express a partial index, and declaring a
-- full one there would describe an index we do not create. Matches how the other partial
-- indexes in this directory are handled.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelVersion_modelId_nsfw_idx"
  ON "ModelVersion" ("modelId") WHERE "nsfw";
