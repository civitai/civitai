-- Persist scan content (text / prompt / image reference) when the first
-- moderator verdicts an item. Survives the orchestrator's 30-day TTL so
-- reviewed items stay inspectable for tuning analysis indefinitely.
--
-- contentHash is the primary key (one snapshot per unique input). Subsequent
-- mod verdicts on the same item skip the snapshot write — first verdict wins.
--
-- `content` is a JSON blob whose shape varies by scanner mode (parsed via the
-- scanContentBody zod schema at the boundary). Avoids ALTER TABLE every time
-- we add a new scanner mode or per-mode field.

CREATE TABLE "ScannerContentSnapshot" (
  "contentHash" TEXT         PRIMARY KEY,
  "scanner"     TEXT         NOT NULL,
  "content"     JSONB        NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "ScannerContentSnapshot_scanner_idx"
  ON "ScannerContentSnapshot"("scanner");
