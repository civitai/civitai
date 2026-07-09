-- CreateTable
CREATE TABLE "ClubPostReaction" (
    "id" SERIAL NOT NULL,
    "clubPostId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "reaction" "ReviewReactions" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClubPostReaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ClubPostReaction_clubPostId_userId_reaction_key" ON "ClubPostReaction"("clubPostId", "userId", "reaction");
 
-- AddForeignKey
ALTER TABLE "ClubPostReaction" ADD CONSTRAINT "ClubPostReaction_clubPostId_fkey" FOREIGN KEY ("clubPostId") REFERENCES "ClubPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClubPostReaction" ADD CONSTRAINT "ClubPostReaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
