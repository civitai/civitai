ALTER TYPE "ApiKeyType" ADD VALUE 'Access';
ALTER TYPE "ApiKeyType" ADD VALUE 'Refresh';

-- DropIndex
DROP INDEX "ApiKey_key_key";

-- AlterTable
ALTER TABLE "ApiKey"
ADD COLUMN     "clientId" TEXT;

-- CreateTable
CREATE TABLE "OauthClient" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "grants" TEXT[],
    "userId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
