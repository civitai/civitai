-- CreateEnum
CREATE TYPE "TagEngagementType" AS ENUM ('Hide', 'Follow');

-- CreateTable
CREATE TABLE "TagEngagement" (
    "userId" INTEGER NOT NULL,
    "tagId" INTEGER NOT NULL,
    "type" "TagEngagementType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagEngagement_pkey" PRIMARY KEY ("userId","tagId")
);

-- AddForeignKey
ALTER TABLE "TagEngagement" ADD CONSTRAINT "TagEngagement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagEngagement" ADD CONSTRAINT "TagEngagement_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
