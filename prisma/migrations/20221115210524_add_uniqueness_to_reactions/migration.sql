/*
  Warnings:

  - A unique constraint covering the columns `[reviewId,userId,reaction]` on the table `ReviewReaction` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ReviewReaction_reviewId_userId_reaction_key" ON "ReviewReaction"("reviewId", "userId", "reaction");
