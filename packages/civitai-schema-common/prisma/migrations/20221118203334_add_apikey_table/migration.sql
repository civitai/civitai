-- CreateEnum
CREATE TYPE "KeyScope" AS ENUM ('Read', 'Write');

-- CreateTable
CREATE TABLE "ApiKey" (
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "KeyScope"[],
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_key" ON "ApiKey"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_key_userId_key" ON "ApiKey"("key", "userId");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
