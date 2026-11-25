-- Release check for #10320 (read-only, run once on the replica right before the release that carries it).
-- #10320 removes every reader of meta.removedWithOwner on models. STOP the release if model_key or
-- version_key is above 0: those rows need a moderator-only status first. control must be above 0, which
-- shows the key test reads the column.
SELECT
  (SELECT count(*) FROM "Model" WHERE meta ? 'removedWithOwner') AS model_key,
  (SELECT count(*) FROM "ModelVersion" WHERE meta ? 'removedWithOwner') AS version_key,
  (SELECT count(*) FROM "Model" WHERE status = 'UnpublishedViolation' AND meta ? 'unpublishedAt') AS control;
