/**
 * The tables `childSafetyImageCase` reads, for a PGlite suite whose own schema does not have them.
 * Every statement is IF NOT EXISTS, so a suite that already creates one keeps its own.
 */
export const childSafetyCaseTablesSql = `
  CREATE TABLE IF NOT EXISTS "CsamQueueSetAside" ("imageId" int NOT NULL, outcome text NOT NULL);
  CREATE TABLE IF NOT EXISTS "ImageReport" ("imageId" int NOT NULL, "reportId" int NOT NULL);
  CREATE TABLE IF NOT EXISTS "PostReport" ("postId" int NOT NULL, "reportId" int NOT NULL);
  CREATE TABLE IF NOT EXISTS "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL);
  CREATE TABLE IF NOT EXISTS "ServiceDealReviewReport" ("serviceDealReviewId" int NOT NULL, "reportId" int NOT NULL);
  ALTER TABLE IF EXISTS "Report" ADD COLUMN IF NOT EXISTS reason text, ADD COLUMN IF NOT EXISTS details jsonb;
  ALTER TABLE IF EXISTS "Image" ADD COLUMN IF NOT EXISTS "postId" int;
`;
