-- AlterEnum
ALTER TYPE "TagTarget" ADD VALUE 'Tag';

-- AlterEnum
ALTER TYPE "TagType" ADD VALUE 'System';

-- CreateTable
CREATE TABLE "TagsOnTags" (
    "fromTagId" INTEGER NOT NULL,
    "toTagId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TagsOnTags_pkey" PRIMARY KEY ("fromTagId","toTagId")
);

-- CreateIndex
CREATE INDEX "TagsOnTags_toTagId_idx" ON "TagsOnTags" USING HASH ("toTagId");

-- AddForeignKey
ALTER TABLE "TagsOnTags" ADD CONSTRAINT "TagsOnTags_fromTagId_fkey" FOREIGN KEY ("fromTagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TagsOnTags" ADD CONSTRAINT "TagsOnTags_toTagId_fkey" FOREIGN KEY ("toTagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
