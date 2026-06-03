/*
  Warnings:

  - The primary key for the `BountyBenefactor` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `BountyEngagement` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `ImageConnection` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The primary key for the `TipConnection` table will be changed. If it partially fails, the table could be left without primary key constraint.

*/
-- DropIndex
DROP INDEX "File_id_entityId_entityType_key";

-- AlterTable
ALTER TABLE "BountyBenefactor" DROP CONSTRAINT "BountyBenefactor_pkey",
ADD CONSTRAINT "BountyBenefactor_pkey" PRIMARY KEY ("bountyId", "userId");

-- AlterTable
ALTER TABLE "BountyEngagement" DROP CONSTRAINT "BountyEngagement_pkey",
ADD CONSTRAINT "BountyEngagement_pkey" PRIMARY KEY ("type", "bountyId", "userId");

-- AlterTable
ALTER TABLE "ImageConnection" DROP CONSTRAINT "ImageConnection_pkey",
ADD CONSTRAINT "ImageConnection_pkey" PRIMARY KEY ("imageId", "entityType", "entityId");

-- AlterTable
ALTER TABLE "TipConnection" DROP CONSTRAINT "TipConnection_pkey",
ADD CONSTRAINT "TipConnection_pkey" PRIMARY KEY ("entityType", "entityId", "transactionId");

-- CreateIndex
CREATE INDEX "ArticleReport_articleId_idx" ON "ArticleReport" USING HASH ("articleId");

-- CreateIndex
CREATE INDEX "Bounty_userId_idx" ON "Bounty" USING HASH ("userId");

-- CreateIndex
CREATE INDEX "Bounty_type_idx" ON "Bounty"("type");

-- CreateIndex
CREATE INDEX "Bounty_mode_idx" ON "Bounty"("mode");

-- CreateIndex
CREATE INDEX "BountyBenefactor_bountyId_idx" ON "BountyBenefactor" USING HASH ("bountyId");

-- CreateIndex
CREATE INDEX "BountyBenefactor_userId_idx" ON "BountyBenefactor" USING HASH ("userId");

-- CreateIndex
CREATE INDEX "BountyEngagement_userId_idx" ON "BountyEngagement" USING HASH ("userId");

-- CreateIndex
CREATE INDEX "BountyEntry_bountyId_idx" ON "BountyEntry" USING HASH ("bountyId");

-- CreateIndex
CREATE INDEX "BountyEntryReaction_bountyEntryId_idx" ON "BountyEntryReaction" USING HASH ("bountyEntryId");

-- CreateIndex
CREATE INDEX "BountyEntryReport_bountyEntryId_idx" ON "BountyEntryReport" USING HASH ("bountyEntryId");

-- CreateIndex
CREATE INDEX "BountyReport_bountyId_idx" ON "BountyReport" USING HASH ("bountyId");

-- CreateIndex
CREATE INDEX "CollectionReport_collectionId_idx" ON "CollectionReport" USING HASH ("collectionId");

-- CreateIndex
CREATE INDEX "CommentReport_commentId_idx" ON "CommentReport" USING HASH ("commentId");

-- CreateIndex
CREATE INDEX "CommentV2Report_commentV2Id_idx" ON "CommentV2Report" USING HASH ("commentV2Id");

-- CreateIndex
CREATE INDEX "File_entityType_entityId_idx" ON "File"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ImageConnection_entityType_entityId_idx" ON "ImageConnection"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ImageReport_imageId_idx" ON "ImageReport" USING HASH ("imageId");

-- CreateIndex
CREATE INDEX "ModelReport_modelId_idx" ON "ModelReport" USING HASH ("modelId");

-- CreateIndex
CREATE INDEX "PostReport_postId_idx" ON "PostReport" USING HASH ("postId");

-- CreateIndex
CREATE INDEX "ResourceReviewReport_resourceReviewId_idx" ON "ResourceReviewReport" USING HASH ("resourceReviewId");

-- CreateIndex
CREATE INDEX "UserReport_userId_idx" ON "UserReport" USING HASH ("userId");
