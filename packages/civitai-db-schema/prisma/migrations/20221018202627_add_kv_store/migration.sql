/*
  Warnings:

  - The primary key for the `ModelMetric` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - A unique constraint covering the columns `[modelId,modelVersionId,timeframe]` on the table `ModelMetric` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `timeframe` to the `ModelMetric` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "MetricTimeframe" AS ENUM ('Day', 'Week', 'Month', 'Year', 'AllTime');

-- DropForeignKey
ALTER TABLE "ModelMetric" DROP CONSTRAINT "ModelMetric_modelVersionId_fkey";

-- AlterTable
ALTER TABLE "ModelMetric" DROP CONSTRAINT "ModelMetric_pkey",
ADD COLUMN     "id" SERIAL NOT NULL,
ADD COLUMN     "timeframe" "MetricTimeframe" NOT NULL,
ALTER COLUMN "modelVersionId" DROP NOT NULL,
ADD CONSTRAINT "ModelMetric_pkey" PRIMARY KEY ("id");

-- CreateTable
CREATE TABLE "KeyValue" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "KeyValue_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "model_metric_unique" ON "ModelMetric"("modelId", "modelVersionId", "timeframe");

-- AddForeignKey
ALTER TABLE "ModelMetric" ADD CONSTRAINT "ModelMetric_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
