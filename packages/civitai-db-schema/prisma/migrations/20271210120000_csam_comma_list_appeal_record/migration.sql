-- The appeal decision record's exclusion reads a CSAM block anywhere in "blockedFor", a comma list of block
-- reasons (`csamInBlockedForSql`, packages/civitai-shared/src/csam-blocked-for.ts), instead of only the exact
-- value 'CSAM'. Its TypeScript twin is `excludedRecord` in src/server/jobs/appeal-decision-records.ts; edit both
-- together.
--
-- Apply MANUALLY, per environment, before deploying the web release carrying the twin. Re-runnable.
-- CREATE OR REPLACE keeps the function's owner and grants and leaves the trigger as it is.

CREATE OR REPLACE FUNCTION appeal_decision_record()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  BEGIN
    INSERT INTO "AppealDecisionRecord" (
      "appealId", "imageId", "imageUrl", "pHash", "promptHash", "nsfwLevel",
      "nsfwLevelLocked", "nsfwLevelReason", "aiNsfwLevel", "blockedFor", "decision", "resolvedReason",
      "decidedAt"
    )
    SELECT
      NEW.id, i.id, i.url, i."pHash", md5(i.meta->>'prompt'), i."nsfwLevel",
      i."nsfwLevelLocked", i.metadata->>'nsfwLevelReason', i."aiNsfwLevel", i."blockedFor",
      -- "resolvedAt" is a zoneless timestamp holding UTC (Prisma's convention).
      NEW.status::text, NEW."resolvedReason", coalesce(NEW."resolvedAt" AT TIME ZONE 'UTC', now())
    FROM "Image" i
    WHERE i.id = NEW."entityId"
      AND i."needsReview" IS DISTINCT FROM 'csam'
      AND NOT EXISTS (
        SELECT 1 FROM unnest(string_to_array(i."blockedFor", ',')) AS mw_reason(value)
        WHERE lower(btrim(mw_reason.value)) = 'csam'
      )
      AND i."userId" NOT IN (SELECT c."userId" FROM "CsamReport" c WHERE c."userId" IS NOT NULL)
      AND NOT EXISTS (
        SELECT 1 FROM "CsamReport" c
        WHERE c.images @> jsonb_build_array(jsonb_build_object('id', i.id))
      )
    ON CONFLICT ("appealId") DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'appeal_decision_record: appeal % not recorded: %', NEW.id, SQLERRM;
  END;
  RETURN NULL;
END;
$$;
