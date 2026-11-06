-- Shadow audio scan results for videos. Read by nothing that filters, rates or hides media.
CREATE TABLE "ImageAudioScan" (
  "imageId" INTEGER NOT NULL PRIMARY KEY REFERENCES "Image"("id") ON DELETE CASCADE,
  "workflowId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'Pending',
  "flagged" BOOLEAN,
  "hasAudio" BOOLEAN,
  "result" JSONB,
  "resultVersion" INTEGER,
  "error" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3)
);

CREATE UNIQUE INDEX "ImageAudioScan_workflowId_key" ON "ImageAudioScan"("workflowId");
CREATE INDEX "ImageAudioScan_flagged_createdAt_idx" ON "ImageAudioScan"("flagged", "createdAt");
