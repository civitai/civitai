-- Tighten the prod-side trg_sync_model_to_metric trigger.
--
-- Two changes:
--   1. Refuse to propagate a future Model.lastVersionAt into ModelMetric.
--      The Newest feed sorts on mm."lastVersionAt" DESC; a future value
--      pins the model to the top until the date arrives. Defense in depth
--      around updateModelLastVersionAt's `lte: new Date()` guard — even if
--      another path writes a future Model.lastVersionAt, the feed table
--      stays clean.
--   2. Split the AFTER INSERT OR UPDATE trigger into two triggers so the
--      UPDATE branch can carry a WHEN (...) clause that only fires when a
--      synced column actually changed. Avoids ModelMetric write churn for
--      every unrelated Model UPDATE (matches the trg_sync_model_to_base_model_metric
--      pattern from 20260113170510_add_model_base_model_metric).

CREATE OR REPLACE FUNCTION public.sync_model_to_metric()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO "ModelMetric" (
            "modelId",
            "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount",
            "collectedCount", "imageCount",
            "tippedAmountCount", "tippedCount", "generationCount", "updatedAt",
            "status", "availability", "mode", "nsfwLevel", "minor", "poi", "userId", "lastVersionAt"
        )
        VALUES (
            NEW.id,
            0, 0, 0, 0,
            0, 0,
            0, 0, 0, NOW(),
            NEW."status", NEW."availability", NEW."mode", NEW."nsfwLevel", NEW."minor", NEW."poi", NEW."userId",
            CASE
                WHEN NEW."lastVersionAt" IS NULL OR NEW."lastVersionAt" <= NOW()
                THEN NEW."lastVersionAt"
                ELSE NULL
            END
        )
        ON CONFLICT ("modelId") DO UPDATE
        SET
            "status"        = EXCLUDED."status",
            "availability"  = EXCLUDED."availability",
            "mode"          = EXCLUDED."mode",
            "nsfwLevel"     = EXCLUDED."nsfwLevel",
            "minor"         = EXCLUDED."minor",
            "poi"           = EXCLUDED."poi",
            "userId"        = EXCLUDED."userId",
            "lastVersionAt" = CASE
                WHEN EXCLUDED."lastVersionAt" IS NULL OR EXCLUDED."lastVersionAt" <= NOW()
                THEN EXCLUDED."lastVersionAt"
                ELSE "ModelMetric"."lastVersionAt"
            END;

        RETURN NEW;
    END IF;

    IF (TG_OP = 'UPDATE') THEN
        INSERT INTO "ModelMetric" (
            "modelId",
            "downloadCount", "thumbsUpCount", "thumbsDownCount", "commentCount",
            "collectedCount", "imageCount",
            "tippedAmountCount", "tippedCount", "generationCount", "updatedAt",
            "status", "availability", "mode", "nsfwLevel", "minor", "poi", "userId", "lastVersionAt"
        )
        VALUES (
            NEW.id,
            0, 0, 0, 0,
            0, 0,
            0, 0, 0, NOW(),
            NEW."status", NEW."availability", NEW."mode", NEW."nsfwLevel", NEW."minor", NEW."poi", NEW."userId",
            CASE
                WHEN NEW."lastVersionAt" IS NULL OR NEW."lastVersionAt" <= NOW()
                THEN NEW."lastVersionAt"
                ELSE NULL
            END
        )
        ON CONFLICT ("modelId") DO UPDATE
        SET
            "status"        = EXCLUDED."status",
            "availability"  = EXCLUDED."availability",
            "mode"          = EXCLUDED."mode",
            "nsfwLevel"     = EXCLUDED."nsfwLevel",
            "minor"         = EXCLUDED."minor",
            "poi"           = EXCLUDED."poi",
            "userId"        = EXCLUDED."userId",
            "lastVersionAt" = CASE
                WHEN EXCLUDED."lastVersionAt" IS NULL OR EXCLUDED."lastVersionAt" <= NOW()
                THEN EXCLUDED."lastVersionAt"
                ELSE "ModelMetric"."lastVersionAt"
            END;

        RETURN NEW;
    END IF;

    RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS trg_sync_model_to_metric ON "Model";
DROP TRIGGER IF EXISTS trg_sync_model_to_metric_insert ON "Model";
DROP TRIGGER IF EXISTS trg_sync_model_to_metric_update ON "Model";

CREATE TRIGGER trg_sync_model_to_metric_insert
AFTER INSERT ON "Model"
FOR EACH ROW
EXECUTE FUNCTION sync_model_to_metric();

CREATE TRIGGER trg_sync_model_to_metric_update
AFTER UPDATE ON "Model"
FOR EACH ROW
WHEN (
  OLD.status          IS DISTINCT FROM NEW.status          OR
  OLD.availability    IS DISTINCT FROM NEW.availability    OR
  OLD.mode            IS DISTINCT FROM NEW.mode            OR
  OLD."nsfwLevel"     IS DISTINCT FROM NEW."nsfwLevel"     OR
  OLD.minor           IS DISTINCT FROM NEW.minor           OR
  OLD.poi             IS DISTINCT FROM NEW.poi             OR
  OLD."userId"        IS DISTINCT FROM NEW."userId"        OR
  OLD."lastVersionAt" IS DISTINCT FROM NEW."lastVersionAt"
)
EXECUTE FUNCTION sync_model_to_metric();
