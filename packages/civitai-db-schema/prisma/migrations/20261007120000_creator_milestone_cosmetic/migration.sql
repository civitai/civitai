-- Idempotent: applied by hand, possibly more than once.
--
-- Lets a milestone grant cosmetics beyond its badge (CreatorMilestone.cosmeticId), e.g. the
-- Supernova name plate. Rows are added separately, once the cosmetics exist.
--
-- 🔴 APPLY BEFORE THE CODE THAT READS THIS TABLE DEPLOYS: the grant query joins it, and a missing
-- table fails every grant, including the nightly score tiers.

SET lock_timeout = '3s';

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "CreatorMilestoneCosmetic" (
  "milestoneKey" TEXT NOT NULL,
  "cosmeticId" INTEGER NOT NULL,
  CONSTRAINT "CreatorMilestoneCosmetic_pkey" PRIMARY KEY ("milestoneKey", "cosmeticId"),
  CONSTRAINT "CreatorMilestoneCosmetic_milestoneKey_fkey" FOREIGN KEY ("milestoneKey")
    REFERENCES "CreatorMilestone"("key") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "CreatorMilestoneCosmetic_cosmeticId_fkey" FOREIGN KEY ("cosmeticId")
    REFERENCES "Cosmetic"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Serves the FK check when a Cosmetic is deleted.
CREATE INDEX IF NOT EXISTS "CreatorMilestoneCosmetic_cosmeticId_idx"
  ON "CreatorMilestoneCosmetic"("cosmeticId");

COMMIT;
