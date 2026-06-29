-- CreateEnum
CREATE TYPE "ModerationRuleAction" AS ENUM ('Approve', 'Block', 'Hold');

-- CreateTable
CREATE TABLE "ModerationRule" (
    "id" SERIAL NOT NULL,
    "entityType" "EntityType" NOT NULL,
    "definition" JSONB NOT NULL,
    "action" "ModerationRuleAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "order" INTEGER,
    "reason" TEXT,

    CONSTRAINT "ModerationRule_pkey" PRIMARY KEY ("id")
);
