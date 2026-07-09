-- CreateEnum
CREATE TYPE "UserRestrictionStatus" AS ENUM ('Pending', 'Upheld', 'Overturned');

-- CreateTable
CREATE TABLE "UserRestriction" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'generation',
    "status" "UserRestrictionStatus" NOT NULL DEFAULT 'Pending',
    "triggers" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" INTEGER,
    "resolvedMessage" TEXT,
    "userMessage" TEXT,
    "userMessageAt" TIMESTAMP(3),

    CONSTRAINT "UserRestriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptAllowlist" (
    "id" SERIAL NOT NULL,
    "trigger" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "addedBy" INTEGER NOT NULL,
    "reason" TEXT,
    "userRestrictionId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptAllowlist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRestriction_userId_idx" ON "UserRestriction"("userId");
CREATE INDEX "UserRestriction_status_idx" ON "UserRestriction"("status");
CREATE INDEX "UserRestriction_type_status_idx" ON "UserRestriction"("type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PromptAllowlist_trigger_category_key" ON "PromptAllowlist"("trigger", "category");
CREATE INDEX "PromptAllowlist_category_idx" ON "PromptAllowlist"("category");

-- AddForeignKey
ALTER TABLE "UserRestriction" ADD CONSTRAINT "UserRestriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- UpdateTrigger: Only nullify mutedAt on unmute; no longer auto-set mutedAt on mute
CREATE OR REPLACE FUNCTION update_muted_at()
RETURNS TRIGGER AS $$
BEGIN
    IF NOT NEW.muted THEN
        NEW."mutedAt" := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
