-- Training Studio `Training Data` placeholders still waiting for the archive-studio-training-datasets
-- job to replace them with the run's dataset zip. Without it the job's newest-first lookup walks the
-- "ModelFile" primary key backwards on every run once the backlog is empty.
--
-- The predicate is the job's WHERE clause verbatim (getPendingStudioDatasetFileIds): change both or
-- neither, or the planner stops matching it.
--
-- Apply any time: the job works without it, only slower. Run OUTSIDE a transaction (CONCURRENTLY
-- cannot run inside one). A cancelled build leaves an invalid index under this name, which IF NOT
-- EXISTS then skips: check pg_index.indisvalid after applying, and if false, DROP INDEX CONCURRENTLY
-- and run this again.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ModelFile_studio_dataset_pending_idx"
  ON "ModelFile" (id)
  WHERE type = 'Training Data'
    AND "sizeKB" = 0
    AND metadata ? 'selectedEpochUrl'
    AND NOT metadata ? 'datasetArchive';
