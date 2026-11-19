import { IMAGE_USES } from '../content-deletion.db';

/**
 * DDL for a test database that runs `queueImageDeletes`: every table its check reads, with only the
 * columns it reads, added to whatever the test already created.
 */
export const imageUseTablesSql = [
  `CREATE TABLE IF NOT EXISTS "Image" (id int PRIMARY KEY, "userId" int NOT NULL)`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS url text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "postId" int`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "needsReview" text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "blockedFor" text`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS ingestion text NOT NULL DEFAULT 'Scanned'`,
  `ALTER TABLE "Image" ADD COLUMN IF NOT EXISTS "nsfwLevel" int NOT NULL DEFAULT 1`,
  `CREATE TABLE IF NOT EXISTS "ImageReport" ("imageId" int NOT NULL)`,
  `ALTER TABLE "ImageReport" ADD COLUMN IF NOT EXISTS "reportId" int`,
  `CREATE TABLE IF NOT EXISTS "Report" (id int PRIMARY KEY)`,
  `ALTER TABLE "Report" ADD COLUMN IF NOT EXISTS reason text`,
  `CREATE TABLE IF NOT EXISTS "CsamReport" (id serial PRIMARY KEY)`,
  `ALTER TABLE "CsamReport" ADD COLUMN IF NOT EXISTS images jsonb NOT NULL DEFAULT '[]'`,
  `CREATE TABLE IF NOT EXISTS "Cosmetic" (id int PRIMARY KEY)`,
  `ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS data jsonb`,
  `CREATE TABLE IF NOT EXISTS "CosmeticShopItem" (id serial PRIMARY KEY)`,
  `ALTER TABLE "CosmeticShopItem" ADD COLUMN IF NOT EXISTS "cosmeticId" int`,
  `ALTER TABLE "CosmeticShopItem" ADD COLUMN IF NOT EXISTS meta jsonb`,
  `CREATE TABLE IF NOT EXISTS "ItemDefinition" (id serial PRIMARY KEY)`,
  `ALTER TABLE "ItemDefinition" ADD COLUMN IF NOT EXISTS "imageUrl" text`,
  `CREATE TABLE IF NOT EXISTS "ImageCdnShopTakedown" (url text PRIMARY KEY)`,
  ...Object.values(IMAGE_USES).flatMap(([table, column]) => [
    `CREATE TABLE IF NOT EXISTS "${table}" ()`,
    `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" int`,
  ]),
].join(';\n');
