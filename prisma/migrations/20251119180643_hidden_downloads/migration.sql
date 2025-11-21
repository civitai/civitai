-- Add migration here
-- Create table to track hidden downloads for users
CREATE TABLE "HiddenDownload" (
  "userId" INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "HiddenDownload_pkey" PRIMARY KEY ("userId", "modelVersionId")
);
