import { INQUISITOR_IMAGE_SCHEMA } from '../knights/__tests__/inquisitor-schema';

/** The tables the image appeals queue, its ruling actions and the shared media access rule read,
 *  for their pglite tests. */
export const APPEAL_MEDIA_SCHEMA = `${INQUISITOR_IMAGE_SCHEMA}
ALTER TABLE "Image" ADD COLUMN width INTEGER, ADD COLUMN height INTEGER,
  ADD COLUMN poi BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "modelRestricted" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN username TEXT;
CREATE TABLE "Appeal" (
  id SERIAL PRIMARY KEY, "userId" INTEGER NOT NULL, "entityType" TEXT NOT NULL,
  "entityId" INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
  "appealMessage" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(), "resolvedBy" INTEGER, "resolvedAt" TIMESTAMP(3),
  "resolvedReason" TEXT, "resolvedMessage" TEXT, "entityRemovedAt" TIMESTAMP(3), category TEXT
);
CREATE TABLE "AppealDecisionRecord" ("appealId" INTEGER, "removalLabel" TEXT);
CREATE TABLE "ModActivity" (
  "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, activity TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT now(), details JSONB
);
CREATE TABLE "Report" (
  id INTEGER PRIMARY KEY, "userId" INTEGER, reason TEXT, status TEXT, details JSONB,
  "createdAt" TIMESTAMP(3)
);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "Model3D" (id INTEGER PRIMARY KEY, name TEXT, status TEXT, "thumbnailImageId" INTEGER);
`;

/** `APPEAL_MEDIA_SCHEMA` and what Image Lookup, Bulk Image Manager and the report actions read. */
export const IMAGE_PAGES_SCHEMA = `${APPEAL_MEDIA_SCHEMA}
ALTER TABLE "Image" ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  ADD COLUMN "updatedAt" TIMESTAMP(3), ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "scannedAt" TIMESTAMP(3), ADD COLUMN "hideMeta" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN hash TEXT, ADD COLUMN meta JSONB, ADD COLUMN metadata JSONB, ADD COLUMN "scanJobs" JSONB,
  ADD COLUMN index INTEGER;
ALTER TABLE "User" ADD COLUMN "bannedAt" TIMESTAMP(3), ADD COLUMN "profilePictureId" INTEGER,
  ADD COLUMN muted BOOLEAN, ADD COLUMN "deletedAt" TIMESTAMP(3), ADD COLUMN "isModerator" BOOLEAN,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now();
ALTER TABLE "Post" ADD COLUMN title TEXT, ADD COLUMN detail TEXT,
  ADD COLUMN "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  ADD COLUMN "nsfwLevel" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "tosViolation" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN unlisted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN availability TEXT NOT NULL DEFAULT 'Public';
ALTER TABLE "TagsOnImageDetails" ADD COLUMN automated BOOLEAN, ADD COLUMN confidence INTEGER,
  ADD COLUMN "needsReview" BOOLEAN, ADD COLUMN source TEXT;
CREATE TABLE "Tag" (id INTEGER PRIMARY KEY, name TEXT, "nsfwLevel" INTEGER, "isCategory" BOOLEAN);
CREATE TABLE "ShadowTagsOnImage" ("imageId" INTEGER, "tagId" INTEGER, confidence INTEGER);
ALTER TABLE "Report" ADD COLUMN "internalNotes" TEXT, ADD COLUMN "alsoReportedBy" INTEGER[],
  ADD COLUMN "previouslyReviewedCount" INTEGER, ADD COLUMN "statusSetAt" TIMESTAMP(3),
  ADD COLUMN "statusSetBy" INTEGER;
ALTER TABLE "ModActivity" ADD COLUMN id SERIAL;
CREATE TABLE "ImageReaction" (
  id SERIAL PRIMARY KEY, "userId" INTEGER, "imageId" INTEGER, reaction TEXT,
  "createdAt" TIMESTAMP(3), "updatedAt" TIMESTAMP(3)
);
CREATE TABLE "ServiceDealReviewImage" ("reviewId" INTEGER NOT NULL, "imageId" INTEGER NOT NULL UNIQUE);
`;
