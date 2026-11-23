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
  "userId" INTEGER, "entityType" TEXT, "entityId" INTEGER, activity TEXT, "createdAt" TIMESTAMP(3)
);
CREATE TABLE "Report" (
  id INTEGER PRIMARY KEY, "userId" INTEGER, reason TEXT, status TEXT, details JSONB,
  "createdAt" TIMESTAMP(3)
);
CREATE TABLE "ImageReport" ("imageId" INTEGER, "reportId" INTEGER);
CREATE TABLE "Model3D" (id INTEGER PRIMARY KEY, name TEXT, status TEXT, "thumbnailImageId" INTEGER);
`;
