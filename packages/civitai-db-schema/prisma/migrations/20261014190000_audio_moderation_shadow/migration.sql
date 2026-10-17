CREATE TABLE "AudioModerationScan" (
  "id" SERIAL PRIMARY KEY,
  "imageId" INTEGER REFERENCES "Image"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "sourceDeletedAt" TIMESTAMP(3),
  "sourceUrl" TEXT NOT NULL,
  "sourceHash" TEXT NOT NULL,
  "status" "EntityModerationStatus" NOT NULL DEFAULT 'Pending',
  "attemptId" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "workflowId" TEXT,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "error" TEXT,
  "result" JSONB,
  "flagged" BOOLEAN,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  "wouldBlock" BOOLEAN,
  "reviewedAt" TIMESTAMP(3),
  "reviewerId" INTEGER REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "reviewNotes" TEXT
);
CREATE UNIQUE INDEX "AudioModerationScan_imageId_sourceHash_key" ON "AudioModerationScan"("imageId", "sourceHash");
CREATE INDEX "AudioModerationScan_status_nextAttemptAt_idx" ON "AudioModerationScan"("status", "nextAttemptAt");
CREATE INDEX "AudioModerationScan_workflowId_idx" ON "AudioModerationScan"("workflowId");
CREATE INDEX "AudioModerationScan_flagged_reviewedAt_id_idx" ON "AudioModerationScan"("flagged", "reviewedAt", "id");
CREATE INDEX "AudioModerationScan_createdAt_idx" ON "AudioModerationScan"("createdAt");

-- Enqueue in the media transaction, including imports and uploads that bypass the web handler.
-- The dispatcher is independently gated; no trigger changes visibility or ratings.
CREATE FUNCTION enqueue_audio_moderation_scan() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.type IN ('video', 'audio') THEN
    INSERT INTO "AudioModerationScan" ("imageId", "sourceUrl", "sourceHash")
    VALUES (NEW.id, NEW.url, md5(NEW.url))
    ON CONFLICT ("imageId", "sourceHash") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER enqueue_audio_moderation_scan
AFTER INSERT OR UPDATE OF url, type ON "Image"
FOR EACH ROW EXECUTE FUNCTION enqueue_audio_moderation_scan();

-- Keep sample denominators and decisions when a source is deleted, without retaining its content.
CREATE FUNCTION redact_deleted_audio_moderation_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "AudioModerationScan" SET
    "sourceUrl" = '', "sourceDeletedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP,
    "result" = "result" - 'lyrics',
    "status" = CASE WHEN "status" = 'Succeeded' THEN "status" ELSE 'Canceled'::"EntityModerationStatus" END,
    "error" = CASE WHEN "status" = 'Succeeded' THEN NULL ELSE 'Media was deleted' END
  WHERE "imageId" = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER redact_deleted_audio_moderation_source
BEFORE DELETE ON "Image"
FOR EACH ROW EXECUTE FUNCTION redact_deleted_audio_moderation_source();
