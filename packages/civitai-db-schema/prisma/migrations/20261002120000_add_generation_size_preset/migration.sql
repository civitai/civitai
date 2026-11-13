-- CreateTable
CREATE TABLE "GenerationSizePreset" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GenerationSizePreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GenerationSizePreset_userId_idx" ON "GenerationSizePreset"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationSizePreset_userId_width_height_key" ON "GenerationSizePreset"("userId", "width", "height");

-- AddForeignKey
ALTER TABLE "GenerationSizePreset" ADD CONSTRAINT "GenerationSizePreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
