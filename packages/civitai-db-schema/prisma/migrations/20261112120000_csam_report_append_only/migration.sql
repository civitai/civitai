-- A sent CSAM report is append-only. Once "reportSentAt" is set, its identifying columns and
-- "images" are frozen, "details" may only gain keys, and the row may be deleted only after its
-- retention period and while no evidence hold covers its users. Every change that passes, and
-- every delete, is recorded in "CsamReportAudit", whose rows cannot be changed or removed.
--
-- The guard runs as its owner, so a role that may write "CsamReport" needs no grant on the audit
-- table. Apply this as the owner of "CsamReport".
--
-- Creates a key, generated in this database and never leaving it, for the details fingerprint. Only
-- the owner can read it or compute a fingerprint.

CREATE SCHEMA IF NOT EXISTS csam_audit;
REVOKE ALL ON SCHEMA csam_audit FROM PUBLIC;

CREATE TABLE IF NOT EXISTS csam_audit.secret (
  "id"  BOOLEAN PRIMARY KEY DEFAULT true CHECK ("id"),
  "key" TEXT NOT NULL
);
INSERT INTO csam_audit.secret ("key")
VALUES (replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
ON CONFLICT DO NOTHING;
REVOKE ALL ON csam_audit.secret FROM PUBLIC;

CREATE OR REPLACE FUNCTION csam_audit.details_fingerprint(p_details JSONB)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = csam_audit, pg_temp
AS $$
  SELECT encode(sha256(convert_to(s."key" || ':' || p_details::text, 'UTF8')), 'hex')
  FROM csam_audit.secret s
$$;
-- Executable by anyone, it would let a reader test guessed details against the audit.
REVOKE EXECUTE ON FUNCTION csam_audit.details_fingerprint(JSONB) FROM PUBLIC;

CREATE TABLE "CsamReportAudit" (
  "id" SERIAL PRIMARY KEY,
  "csamReportId" INTEGER NOT NULL,
  "op" TEXT NOT NULL,
  "oldUserId" INTEGER,
  "oldReportId" INTEGER,
  "oldType" TEXT,
  "oldSecondaryUserId" INTEGER,
  "oldImageCount" INTEGER,
  -- A keyed fingerprint of the details for tamper detection, never their content.
  "oldDetailsFingerprint" TEXT,
  "oldReportSentAt" TIMESTAMP(3),
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The session's login: inside the guard, current_user names the guard's owner instead.
  "changedBy" TEXT NOT NULL DEFAULT session_user
);

CREATE INDEX "CsamReportAudit_csamReportId_idx" ON "CsamReportAudit" ("csamReportId");

CREATE OR REPLACE FUNCTION csam_report_guard_sent() RETURNS trigger AS $$
DECLARE
  secondary_user INTEGER;
  held BOOLEAN;
BEGIN
  IF (OLD."details" ->> 'secondaryUserId') ~ '^[0-9]{1,9}$' THEN
    secondary_user := (OLD."details" ->> 'secondaryUserId')::int;
  END IF;

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
      EXECUTE 'SELECT EXISTS (SELECT 1 FROM "EvidenceHeldUser" WHERE "userId" = ANY($1))'
        INTO held
        USING ARRAY[OLD."userId", secondary_user];
      IF held THEN
        RAISE EXCEPTION 'CsamReport % is under an evidence hold and cannot be deleted', OLD."id";
      END IF;
    END IF;
    INSERT INTO "CsamReportAudit" (
      "csamReportId", "op", "oldUserId", "oldSecondaryUserId", "oldReportId", "oldType",
      "oldImageCount", "oldDetailsFingerprint", "oldReportSentAt"
    )
    VALUES (
      OLD."id", 'delete', OLD."userId", secondary_user, OLD."reportId", OLD."type"::text,
      CASE WHEN jsonb_typeof(OLD."images") = 'array' THEN jsonb_array_length(OLD."images") END,
      csam_audit.details_fingerprint(OLD."details"), OLD."reportSentAt"
    );
    RETURN OLD;
  END IF;

  IF OLD."reportSentAt" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
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

  INSERT INTO "CsamReportAudit" (
      "csamReportId", "op", "oldUserId", "oldSecondaryUserId", "oldReportId", "oldType",
      "oldImageCount", "oldDetailsFingerprint", "oldReportSentAt"
  )
  VALUES (
    OLD."id", 'update', OLD."userId", secondary_user, OLD."reportId", OLD."type"::text,
    CASE WHEN jsonb_typeof(OLD."images") = 'array' THEN jsonb_array_length(OLD."images") END,
    csam_audit.details_fingerprint(OLD."details"), OLD."reportSentAt"
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

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

CREATE OR REPLACE FUNCTION csam_report_audit_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CsamReportAudit rows cannot be changed or removed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CsamReportAudit_refuse_change"
BEFORE UPDATE OR DELETE ON "CsamReportAudit"
FOR EACH ROW EXECUTE FUNCTION csam_report_audit_refuse_change();

CREATE TRIGGER "CsamReportAudit_refuse_truncate"
BEFORE TRUNCATE ON "CsamReportAudit"
FOR EACH STATEMENT EXECUTE FUNCTION csam_report_audit_refuse_change();
