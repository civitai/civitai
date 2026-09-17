-- CreateEnum
CREATE TYPE "HuggingFaceImportStatus" AS ENUM ('Queued', 'Transferring', 'Completed', 'Failed', 'Canceled');

-- CreateTable
CREATE TABLE "HuggingFaceImport" (
    "id" SERIAL NOT NULL,
    "repo" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "groupName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sizeBytes" BIGINT,
    "sourceSha256" TEXT,
    "status" "HuggingFaceImportStatus" NOT NULL DEFAULT 'Queued',
    "bytesTransferred" BIGINT NOT NULL DEFAULT 0,
    "uploadId" TEXT,
    "partSize" INTEGER,
    "parts" JSONB,
    "bucket" TEXT,
    "key" TEXT,
    "url" TEXT,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "userId" INTEGER,
    "modelVersionId" INTEGER,
    "modelFileId" INTEGER,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "heartbeatAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HuggingFaceImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HuggingFaceImport_repo_revision_filename_key" ON "HuggingFaceImport"("repo", "revision", "filename");

-- CreateIndex
CREATE INDEX "HuggingFaceImport_status_createdAt_idx" ON "HuggingFaceImport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "HuggingFaceImport_groupName_idx" ON "HuggingFaceImport"("groupName");
