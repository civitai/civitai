-- AlterTable
ALTER TABLE "Model" ADD COLUMN     "appId" INTEGER;

-- CreateTable
CREATE TABLE "ModelApp" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,

    CONSTRAINT "ModelApp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelApp_name_idx" ON "ModelApp" USING HASH ("name");

-- AddForeignKey
ALTER TABLE "Model" ADD CONSTRAINT "Model_appId_fkey" FOREIGN KEY ("appId") REFERENCES "ModelApp"("id") ON DELETE SET NULL ON UPDATE CASCADE;
