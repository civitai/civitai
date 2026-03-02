-- CreateEnum: StrikeReason
CREATE TYPE "StrikeReason" AS ENUM ('BlockedContent', 'RealisticMinorContent', 'CSAMContent', 'TOSViolation', 'HarassmentContent', 'ProhibitedContent', 'ManualModAction');

-- CreateEnum: StrikeStatus
CREATE TYPE "StrikeStatus" AS ENUM ('Active', 'Expired', 'Voided');

-- AlterTable: Add muteExpiresAt to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "muteExpiresAt" TIMESTAMP(3);

-- CreateTable: UserStrike
CREATE TABLE IF NOT EXISTS "UserStrike" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "reason" "StrikeReason" NOT NULL,
    "status" "StrikeStatus" NOT NULL DEFAULT 'Active',
    "points" INTEGER NOT NULL DEFAULT 1,
    "description" VARCHAR(1000) NOT NULL,
    "internalNotes" VARCHAR(2000),
    "entityType" "EntityType",
    "entityId" INTEGER,
    "reportId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" INTEGER,
    "voidReason" VARCHAR(1000),
    "issuedBy" INTEGER,

    CONSTRAINT "UserStrike_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "UserStrike_userId_status_idx" ON "UserStrike"("userId", "status");
CREATE INDEX IF NOT EXISTS "UserStrike_userId_expiresAt_idx" ON "UserStrike"("userId", "expiresAt");
CREATE INDEX IF NOT EXISTS "UserStrike_status_idx" ON "UserStrike"("status");
CREATE INDEX IF NOT EXISTS "UserStrike_createdAt_idx" ON "UserStrike"("createdAt");

-- AddForeignKey: userId -> User
ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: voidedBy -> User
ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_voidedBy_fkey" FOREIGN KEY ("voidedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: issuedBy -> User
ALTER TABLE "UserStrike" ADD CONSTRAINT "UserStrike_issuedBy_fkey" FOREIGN KEY ("issuedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
