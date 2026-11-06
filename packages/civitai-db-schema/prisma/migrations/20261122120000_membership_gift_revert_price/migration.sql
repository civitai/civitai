-- Applied by hand (we do not run `prisma migrate deploy`). Run BEFORE the deploy: the new build
-- reads and writes this column, and the build live today ignores it.
ALTER TABLE "MembershipGift" ADD COLUMN "revertPriceId" TEXT;
