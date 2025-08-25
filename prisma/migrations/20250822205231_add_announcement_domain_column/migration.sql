-- CreateEnum
CREATE TYPE "public"."DomainColor" AS ENUM ('red', 'green', 'blue', 'all');

-- AlterTable
ALTER TABLE "public"."Announcement" ADD COLUMN     "domain" "public"."DomainColor"[] DEFAULT ARRAY['all']::"public"."DomainColor"[];
