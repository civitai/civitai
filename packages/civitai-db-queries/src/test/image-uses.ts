import {
  DEAL_FILE_IMAGE_USES,
  IMAGE_USES,
  IMAGE_USES_WITHOUT_RELATION,
} from '../content-deletion.db';

/**
 * DDL for a test database that runs `queueImageDeletes` or the child-safety case: every table they
 * read, with only the columns they read, added to whatever the test already created.
 */
export const imageUseTablesSql = [
  // The kept-delete lift casts a recorded ingestion to it, whatever type the test gave the column.
  `DO $$ BEGIN
    CREATE TYPE "ImageIngestionStatus" AS ENUM (
      'Pending', 'Scanned', 'Error', 'Blocked', 'NotFound', 'PendingManualAssignment', 'Rescan'
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
  `CREATE TABLE IF NOT EXISTS "Image" (id int PRIMARY KEY, "userId" int NOT NULL)`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS url text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "postId" int`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "needsReview" text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "blockedFor" text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS ingestion text NOT NULL DEFAULT 'Scanned'`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "nsfwLevel" int NOT NULL DEFAULT 1`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS flags int NOT NULL DEFAULT 0`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "updatedAt" timestamp(3)`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS metadata jsonb`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "scannedAt" timestamp(3)`,
  `CREATE TABLE IF NOT EXISTS "ImageReport" ("imageId" int NOT NULL)`,
  `ALTER TABLE "ImageReport" ADD COLUMN IF NOT EXISTS "reportId" int`,
  `CREATE TABLE IF NOT EXISTS "Report" (id int PRIMARY KEY)`,
  `ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS reason text`,
  `ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'Pending'`,
  `ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'`,
  `CREATE TABLE IF NOT EXISTS "PostReport" ("postId" int NOT NULL, "reportId" int NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS "CsamQueueSetAside" ("imageId" int NOT NULL)`,
  `ALTER TABLE "CsamQueueSetAside" ADD COLUMN IF NOT EXISTS outcome text`,
  `CREATE TABLE IF NOT EXISTS "CsamReport" (id serial PRIMARY KEY)`,
  `ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'`,
  `ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS "reportSentAt" timestamp(3)`,
  `ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS details jsonb NOT NULL DEFAULT '{}'`,
  `ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS "userId" int`,
  `CREATE TABLE IF NOT EXISTS "Appeal" (status text)`,
  `ALTER TABLE "Appeal" ADD COLUMN IF NOT EXISTS "entityType" text`,
  `ALTER TABLE "Appeal" ADD COLUMN IF NOT EXISTS "entityId" int`,
  `CREATE TABLE IF NOT EXISTS "Cosmetic" (id int PRIMARY KEY)`,
  `ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS data jsonb`,
  `CREATE TABLE IF NOT EXISTS "CosmeticShopItem" (id serial PRIMARY KEY)`,
  `ALTER TABLE "CosmeticShopItem" ADD COLUMN IF NOT EXISTS "cosmeticId" int`,
  `ALTER TABLE "CosmeticShopItem" ADD COLUMN IF NOT EXISTS meta jsonb`,
  `CREATE TABLE IF NOT EXISTS "ItemDefinition" (id serial PRIMARY KEY)`,
  `ALTER TABLE "ItemDefinition" ADD COLUMN IF NOT EXISTS "imageUrl" text`,
  `CREATE TABLE IF NOT EXISTS "ImageCdnShopTakedown" (url text PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS "ModActivity" (id serial PRIMARY KEY)`,
  `ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "userId" int`,
  `ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS activity text`,
  `ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "entityType" text`,
  `ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "entityId" int`,
  `ALTER TABLE "ModActivity" ADD COLUMN IF NOT EXISTS "createdAt" timestamp(3) NOT NULL DEFAULT now()`,
  ...[...Object.values(IMAGE_USES), ...Object.values(IMAGE_USES_WITHOUT_RELATION)].flatMap(
    ([table, column]) => [
      `CREATE TABLE IF NOT EXISTS "${table}" ()`,
      `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" int`,
    ]
  ),
  // A deal file names its copy's key before it points at the copy.
  ...Object.values(DEAL_FILE_IMAGE_USES).map(
    ([table]) => `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "scanKey" text`
  ),
  `ALTER TABLE "ServiceDealReviewImage" ADD COLUMN IF NOT EXISTS "reviewId" int`,
  `CREATE TABLE IF NOT EXISTS "ServiceDealReviewReport" ("reportId" int NOT NULL)`,
  `ALTER TABLE "ServiceDealReviewReport" ADD COLUMN IF NOT EXISTS "serviceDealReviewId" int`,
  // The kept-delete lift reads the owner's standing.
  `CREATE TABLE IF NOT EXISTS "User" (id int PRIMARY KEY)`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS id int`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "deletedAt" timestamp(3)`,
  `ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bannedAt" timestamp(3)`,
].join(';\n');

/** DDL for a test database that runs `serverCopyImageSql`: the deal file and review copy tables. */
export const serverCopyTablesSql = [
  `CREATE TABLE IF NOT EXISTS "ServiceDealReviewImage" ("reviewId" int NOT NULL, "imageId" int NOT NULL)`,
  ...Object.values(DEAL_FILE_IMAGE_USES).flatMap(([table, column]) => [
    `CREATE TABLE IF NOT EXISTS "${table}" (id serial PRIMARY KEY)`,
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" int`,
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "scanKey" text`,
  ]),
].join(';\n');
