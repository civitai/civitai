-- CreateTable
CREATE TABLE "PostPreset" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" CITEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostPreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PostPreset_userId_name_key" ON "PostPreset"("userId", "name");

-- AddForeignKey
ALTER TABLE "PostPreset" ADD CONSTRAINT "PostPreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
