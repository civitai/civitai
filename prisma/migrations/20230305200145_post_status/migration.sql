-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('Public', 'Hidden');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "status" "PostStatus" NOT NULL DEFAULT 'Hidden';
