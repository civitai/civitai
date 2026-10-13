-- Training Studio publishes created a public 0 KB "Training Data" placeholder that only carries the
-- run's training results; hide the existing ones from the public files list.
UPDATE "ModelFile" mf
SET visibility = 'Private'
FROM "ModelVersion" mv
JOIN "Model" m ON m.id = mv."modelId"
WHERE mf."modelVersionId" = mv.id
  AND mf.type = 'Training Data'
  AND mf."sizeKB" = 0
  AND mf.visibility = 'Public'
  AND m.meta ? 'trainingStudioWorkflowId';
