
-- AlterTable
ALTER TABLE "Model" ALTER COLUMN "allowCommercialUse" SET DEFAULT ARRAY['Sell']::"CommercialUse"[];

-- AlterTable
ALTER TABLE "NotificationViewed" ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "ResourceReview" ALTER COLUMN "recommended" DROP DEFAULT;

-- CreateTable
CREATE TABLE "NsfwLevelUpdateQueue" (
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NsfwLevelUpdateQueue_pkey" PRIMARY KEY ("entityType","entityId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Article_coverId_key" ON "Article"("coverId");

-- AddForeignKey
ALTER TABLE "Article"
  ADD CONSTRAINT "Article_coverId_fkey" FOREIGN KEY ("coverId") REFERENCES "Image"("id") ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Image" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DeleteQueue" (
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeleteQueue_pkey" PRIMARY KEY ("entityType","entityId")
);
