
-- CreateTable
CREATE TABLE "ModelVersionExploration" (
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "modelVersionId" INTEGER NOT NULL,

    CONSTRAINT "ModelVersionExploration_pkey" PRIMARY KEY ("modelVersionId","name")
);

-- AddForeignKey
ALTER TABLE "ModelVersionExploration" ADD CONSTRAINT "ModelVersionExploration_modelVersionId_fkey" FOREIGN KEY ("modelVersionId") REFERENCES "ModelVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
