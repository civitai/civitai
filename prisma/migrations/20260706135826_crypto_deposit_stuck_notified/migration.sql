-- Track when we've emailed the user + NowPayments support about a deposit stuck
-- in an unsupported/wrapped currency (funds sit at NP, never settled to usdcbase,
-- so we cannot credit Buzz). Null = not yet notified.
ALTER TABLE "CryptoDeposit" ADD COLUMN "stuckNotifiedAt" TIMESTAMP(3);

-- Go-forward only: mark every currently-unresolved deposit as already-notified so
-- the daily notifier skips the existing backlog and only emails NEW stuck cases.
UPDATE "CryptoDeposit" SET "stuckNotifiedAt" = now() WHERE "status" <> 'finished';
