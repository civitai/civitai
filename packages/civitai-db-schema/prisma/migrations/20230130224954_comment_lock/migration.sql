-- AlterTable
ALTER TABLE "Comment" ADD COLUMN     "locked" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "CommentV2" ADD COLUMN     "locked" BOOLEAN DEFAULT false;
