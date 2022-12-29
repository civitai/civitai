/*
  Warnings:

  - You are about to drop the column `bountyId` on the `Tag` table. All the data in the column will be lost.

*/
-- AlterEnum
ALTER TYPE "TagTarget" ADD VALUE 'Bounty';

-- DropForeignKey
ALTER TABLE "Tag" DROP CONSTRAINT "Tag_bountyId_fkey";

-- AlterTable
ALTER TABLE "Tag" DROP COLUMN "bountyId";

-- CreateTable
CREATE TABLE "BountyComment" (
    "bountyId" INTEGER NOT NULL,
    "commentId" INTEGER NOT NULL,

    CONSTRAINT "BountyComment_pkey" PRIMARY KEY ("bountyId","commentId")
);

-- CreateTable
CREATE TABLE "_BountyToTag" (
    "A" INTEGER NOT NULL,
    "B" INTEGER NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "BountyComment_commentId_key" ON "BountyComment"("commentId");

-- CreateIndex
CREATE UNIQUE INDEX "_BountyToTag_AB_unique" ON "_BountyToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_BountyToTag_B_index" ON "_BountyToTag"("B");

-- AddForeignKey
ALTER TABLE "BountyComment" ADD CONSTRAINT "BountyComment_bountyId_fkey" FOREIGN KEY ("bountyId") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BountyComment" ADD CONSTRAINT "BountyComment_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "CommentV2"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BountyToTag" ADD CONSTRAINT "_BountyToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Bounty"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_BountyToTag" ADD CONSTRAINT "_BountyToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
