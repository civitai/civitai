-- Where a queued import is headed, so the transfer job can attach the file when it lands.
-- Both nullable with no default: existing rows are imports nobody asked to auto-attach.
ALTER TABLE "HuggingFaceImport"
  ADD COLUMN "attachVersionId" INTEGER,
  ADD COLUMN "attachType" TEXT;
