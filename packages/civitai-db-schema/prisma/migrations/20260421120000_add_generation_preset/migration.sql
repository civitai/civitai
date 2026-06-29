-- CreateTable
CREATE TABLE "GenerationPreset" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" CITEXT NOT NULL,
    "description" VARCHAR(500),
    "ecosystem" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationPreset_userId_idx" ON "GenerationPreset"("userId");

-- CreateIndex
CREATE INDEX "GenerationPreset_userId_ecosystem_idx" ON "GenerationPreset"("userId", "ecosystem");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationPreset_userId_ecosystem_name_key" ON "GenerationPreset"("userId", "ecosystem", "name");

-- AddForeignKey
ALTER TABLE "GenerationPreset" ADD CONSTRAINT "GenerationPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
