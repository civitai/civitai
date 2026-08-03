-- Comped membership tiers (prisma model "UserMembershipOverride"), managed from the auth hub at
-- /admin/membership. The hub folds this into the session it produces, so a user can hold a tier without a
-- CustomerSubscription. Applied manually. Idempotent.

CREATE TABLE IF NOT EXISTS "UserMembershipOverride" (
    "userId" INTEGER NOT NULL,
    "tier" TEXT NOT NULL,
    "note" TEXT,
    "grantedById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserMembershipOverride_pkey" PRIMARY KEY ("userId")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserMembershipOverride_userId_fkey') THEN
    ALTER TABLE "UserMembershipOverride"
      ADD CONSTRAINT "UserMembershipOverride_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserMembershipOverride_grantedById_fkey') THEN
    ALTER TABLE "UserMembershipOverride"
      ADD CONSTRAINT "UserMembershipOverride_grantedById_fkey"
      FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
