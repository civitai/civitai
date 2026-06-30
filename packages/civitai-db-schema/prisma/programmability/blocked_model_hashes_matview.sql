DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_matviews
        WHERE matviewname = 'BlockedModelHashes'
    ) THEN
        CREATE MATERIALIZED VIEW "BlockedModelHashes" AS
        SELECT DISTINCT
        mfh.hash
        FROM "Model" m
        JOIN "ModelVersion" mv ON mv."modelId" = m.id
        JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id
        JOIN "ModelFileHash" mfh ON mfh."fileId" = mf.id
        WHERE m.status = 'UnpublishedViolation'
        AND mfh.type = 'SHA256'
        AND mf.type = 'Model';
    END IF;
END $$;
