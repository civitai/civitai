-- Apply before the deploy that closes restrictions on account deletion: no row uses the value until
-- that code runs. Backfilling existing rows is a separate step, run only once that deploy is live.
ALTER TYPE "UserRestrictionStatus" ADD VALUE IF NOT EXISTS 'AccountDeleted';
