import { CSAM_LINK_TABLES_SQL } from '../../../../../../../packages/civitai-shared/src/__tests__/csam-restriction-cases';

/** The "Image" table and every table the shared retracted-media predicates read, for the
 *  Inquisitor queue's pglite tests. The Knights tables come from their migration. */
export const INQUISITOR_IMAGE_SCHEMA = `
CREATE TABLE "Image" (
  id INTEGER PRIMARY KEY, url TEXT NOT NULL, name TEXT, type TEXT NOT NULL DEFAULT 'image',
  "mimeType" TEXT, ingestion TEXT NOT NULL DEFAULT 'Scanned', "needsReview" TEXT, "blockedFor" TEXT,
  minor BOOLEAN NOT NULL DEFAULT false, "acceptableMinor" BOOLEAN NOT NULL DEFAULT false,
  "nsfwLevel" INTEGER NOT NULL DEFAULT 0, "nsfwLevelLocked" BOOLEAN NOT NULL DEFAULT false,
  "pHash" BIGINT, "userId" INTEGER NOT NULL DEFAULT 1, "postId" INTEGER
);
CREATE TABLE "Post" (id INTEGER PRIMARY KEY, metadata JSONB, "modelVersionId" INTEGER);
CREATE TABLE "ModelVersion" (id INTEGER PRIMARY KEY, meta JSONB, "modelId" INTEGER);
CREATE TABLE "Model" (id INTEGER PRIMARY KEY, meta JSONB);
CREATE TABLE "User" (id INTEGER PRIMARY KEY, meta JSONB);
CREATE TABLE "ImageCdnAccess" (
  url TEXT PRIMARY KEY, state TEXT NOT NULL,
  "deniedAt" TIMESTAMPTZ NOT NULL DEFAULT now(), "retractedAt" TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE "ImageCdnModeratorDelete" (
  "imageId" INTEGER PRIMARY KEY, url TEXT NOT NULL, "userId" INTEGER, "csamReview" BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE "ImageCdnShopTakedown" (url TEXT NOT NULL, "shopItemId" INTEGER NOT NULL, "userId" INTEGER);
CREATE TABLE "TagsOnImageDetails" ("imageId" INTEGER, "tagId" INTEGER, disabled BOOLEAN NOT NULL DEFAULT false);
CREATE TABLE "BlockedImage" (hash BIGINT, reason TEXT);
CREATE TABLE "ScanLabelItem" (id INTEGER PRIMARY KEY, "imageId" INTEGER, "voidReason" TEXT);
CREATE TABLE "ScanLabelFlag" ("itemId" INTEGER, snapshot JSONB);
CREATE TABLE "ScanLabelVote" ("itemId" INTEGER, reason TEXT);
CREATE TABLE "CsamReport" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, details JSONB, images JSONB, "reportSentAt" TIMESTAMP
);
CREATE TABLE "EvidenceHeldUser" ("userId" INTEGER);
CREATE TABLE "EvidenceHoldImage" ("imageId" INTEGER PRIMARY KEY);
CREATE TABLE "TextScanHold" (id SERIAL PRIMARY KEY, "entityType" TEXT NOT NULL, "entityId" INTEGER NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL);
${CSAM_LINK_TABLES_SQL}`;
