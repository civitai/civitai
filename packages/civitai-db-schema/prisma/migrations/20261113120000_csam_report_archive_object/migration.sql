-- One row per object a CSAM report's evidence archive stored. Written once by the archive and read
-- only by the evidence check; rows are never changed or removed.

CREATE TABLE "CsamReportArchiveObject" (
  "id" SERIAL PRIMARY KEY,
  "csamReportId" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "etag" TEXT,
  "entries" INTEGER,
  "namedExpected" INTEGER,
  "namedMissing" INTEGER,
  "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CsamReportArchiveObject_kind_check"
    CHECK ("kind" IN ('base', 'images', 'generatedImages', 'trainingData'))
);

CREATE INDEX "CsamReportArchiveObject_csamReportId_idx" ON "CsamReportArchiveObject" ("csamReportId");

CREATE OR REPLACE FUNCTION csam_report_archive_object_refuse_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'CsamReportArchiveObject rows cannot be changed or removed';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CsamReportArchiveObject_refuse_change"
BEFORE UPDATE OR DELETE ON "CsamReportArchiveObject"
FOR EACH ROW EXECUTE FUNCTION csam_report_archive_object_refuse_change();

CREATE TRIGGER "CsamReportArchiveObject_refuse_truncate"
BEFORE TRUNCATE ON "CsamReportArchiveObject"
FOR EACH STATEMENT EXECUTE FUNCTION csam_report_archive_object_refuse_change();
