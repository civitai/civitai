/*
  Warnings:

  - The primary key for the `AnswerReaction` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `reactionId` on the `AnswerReaction` table. All the data in the column will be lost.
  - The primary key for the `CommentV2Reaction` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `reactionId` on the `CommentV2Reaction` table. All the data in the column will be lost.
  - The primary key for the `QuestionReaction` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `reactionId` on the `QuestionReaction` table. All the data in the column will be lost.
  - You are about to drop the `Reaction` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[answerId,userId,reaction]` on the table `AnswerReaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[commentId,userId,reaction]` on the table `CommentV2Reaction` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[questionId,userId,reaction]` on the table `QuestionReaction` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `reaction` to the `AnswerReaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `AnswerReaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `AnswerReaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reaction` to the `CommentV2Reaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `CommentV2Reaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `CommentV2Reaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `reaction` to the `QuestionReaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `updatedAt` to the `QuestionReaction` table without a default value. This is not possible if the table is not empty.
  - Added the required column `userId` to the `QuestionReaction` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReviewReactions" ADD VALUE 'Cross';
ALTER TYPE "ReviewReactions" ADD VALUE 'Check';

-- DropForeignKey
ALTER TABLE "AnswerReaction" DROP CONSTRAINT "AnswerReaction_reactionId_fkey";

-- DropForeignKey
ALTER TABLE "CommentV2Reaction" DROP CONSTRAINT "CommentV2Reaction_reactionId_fkey";

-- DropForeignKey
ALTER TABLE "QuestionReaction" DROP CONSTRAINT "QuestionReaction_reactionId_fkey";

-- DropForeignKey
ALTER TABLE "Reaction" DROP CONSTRAINT "Reaction_userId_fkey";

-- DropIndex
DROP INDEX "AnswerReaction_reactionId_key";

-- DropIndex
DROP INDEX "CommentV2Reaction_reactionId_key";

-- DropIndex
DROP INDEX "QuestionReaction_reactionId_key";

-- AlterTable
ALTER TABLE "AnswerReaction" DROP CONSTRAINT "AnswerReaction_pkey",
DROP COLUMN "reactionId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "reaction" "ReviewReactions" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" INTEGER NOT NULL,
ADD CONSTRAINT "AnswerReaction_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "CommentV2Reaction" DROP CONSTRAINT "CommentV2Reaction_pkey",
DROP COLUMN "reactionId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "reaction" "ReviewReactions" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" INTEGER NOT NULL,
ADD CONSTRAINT "CommentV2Reaction_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "QuestionReaction" DROP CONSTRAINT "QuestionReaction_pkey",
DROP COLUMN "reactionId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "reaction" "ReviewReactions" NOT NULL,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "userId" INTEGER NOT NULL,
ADD CONSTRAINT "QuestionReaction_pkey" PRIMARY KEY ("id");

-- DropTable
DROP TABLE "Reaction";

-- CreateIndex
CREATE UNIQUE INDEX "AnswerReaction_answerId_userId_reaction_key" ON "AnswerReaction"("answerId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "CommentV2Reaction_commentId_userId_reaction_key" ON "CommentV2Reaction"("commentId", "userId", "reaction");

-- CreateIndex
CREATE UNIQUE INDEX "QuestionReaction_questionId_userId_reaction_key" ON "QuestionReaction"("questionId", "userId", "reaction");

-- AddForeignKey
ALTER TABLE "QuestionReaction" ADD CONSTRAINT "QuestionReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnswerReaction" ADD CONSTRAINT "AnswerReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentV2Reaction" ADD CONSTRAINT "CommentV2Reaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
