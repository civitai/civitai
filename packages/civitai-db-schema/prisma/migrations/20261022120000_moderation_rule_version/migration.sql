-- Append-only history of Model rules: the moderator app writes one row per create, edit,
-- enable/disable and restore, in the same transaction as the ModerationRule write.
-- Apply before deploying the moderator app version that writes it.
CREATE TABLE "ModerationRuleVersion" (
    "id" SERIAL NOT NULL,
    "ruleId" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "action" "ModerationRuleAction" NOT NULL,
    "reason" TEXT,
    "createdById" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModerationRuleVersion_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ModerationRuleVersion_ruleId_id_idx" ON "ModerationRuleVersion"("ruleId", "id" DESC);

ALTER TABLE "ModerationRuleVersion"
  ADD CONSTRAINT "ModerationRuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId")
  REFERENCES "ModerationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
