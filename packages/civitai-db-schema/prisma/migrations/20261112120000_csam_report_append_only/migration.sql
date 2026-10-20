-- A sent CSAM report is append-only. Once "reportSentAt" is set, its identifying columns and
-- "images" are frozen, "details" may only gain keys, and the row may be deleted only after its
-- retention period and while no evidence hold covers its users. Every change that passes, and
-- every delete, is recorded in "CsamReportAudit".

CREATE TABLE "CsamReportAudit" (
  "id" SERIAL PRIMARY KEY,
  "csamReportId" INTEGER NOT NULL,
  "op" TEXT NOT NULL,
  "oldDetails" JSONB,
  "oldReportSentAt" TIMESTAMP(3),
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "changedBy" TEXT NOT NULL DEFAULT current_user
);

CREATE INDEX "CsamReportAudit_csamReportId_idx" ON "CsamReportAudit" ("csamReportId");

CREATE OR REPLACE FUNCTION csam_report_guard_sent() RETURNS trigger AS $$
DECLARE
  secondary_user INTEGER;
  held BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."reportSentAt" IS NOT NULL THEN
      IF OLD."reportSentAt" > now() - interval '1 year' THEN
        RAISE EXCEPTION 'CsamReport % was sent less than a year ago and cannot be deleted', OLD."id";
      END IF;
      -- The hold view is read dynamically so this function can be created before it exists. Until
      -- it does, no sent report can be cleared of holds, so none is deleted.
      IF to_regclass('"EvidenceHeldUser"') IS NULL THEN
        RAISE EXCEPTION 'CsamReport % cannot be deleted: hold status is unavailable', OLD."id";
      END IF;
      IF (OLD."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$' THEN
        secondary_user := (OLD."details" ->> 'secondaryUserId')::int;
      END IF;
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ANY($1))'
        INTO held
        USING ARRAY[OLD."userId", secondary_user];
      IF held THEN
        RAISE EXCEPTION 'CsamReport % is under an evidence hold and cannot be deleted', OLD."id";
      END IF;
    END IF;
    INSERT INTO "CsamReportAudit" ("csamReportId", "op", "oldDetails", "oldReportSentAt")
    VALUES (OLD."id", 'delete', OLD."details", OLD."reportSentAt");
    RETURN OLD;
  END IF;

  IF OLD."reportSentAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."reportedById" IS DISTINCT FROM OLD."reportedById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW."reportSentAt" IS DISTINCT FROM OLD."reportSentAt"
    OR NEW."reportId" IS DISTINCT FROM OLD."reportId"
    OR NEW."type" IS DISTINCT FROM OLD."type"
    OR NEW."images" IS DISTINCT FROM OLD."images"
  THEN
    RAISE EXCEPTION 'CsamReport % was sent; only details, archivedAt and contentRemovedAt may change', OLD."id";
  END IF;

  -- A details value that is not an object holds nothing to keep, so an object may replace it.
  IF jsonb_typeof(NEW."details") IS DISTINCT FROM 'object'
    OR (jsonb_typeof(OLD."details") = 'object' AND NOT NEW."details" @> OLD."details")
  THEN
    IF NEW."details" IS DISTINCT FROM OLD."details" THEN
      RAISE EXCEPTION 'CsamReport % was sent; its details may only gain keys', OLD."id";
    END IF;
  END IF;

  INSERT INTO "CsamReportAudit" ("csamReportId", "op", "oldDetails", "oldReportSentAt")
  VALUES (OLD."id", 'update', OLD."details", OLD."reportSentAt");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CsamReport_guard_sent"
BEFORE UPDATE OR DELETE ON "CsamReport"
FOR EACH ROW EXECUTE FUNCTION csam_report_guard_sent();

CREATE OR REPLACE FUNCTION csam_report_refuse_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CsamReport cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CsamReport_refuse_truncate"
BEFORE TRUNCATE ON "CsamReport"
FOR EACH STATEMENT EXECUTE FUNCTION csam_report_refuse_truncate();
