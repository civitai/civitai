ALTER TABLE "Bid"
  ADD COLUMN "transactionId" text,
  ADD COLUMN "fromRecurring" boolean not null default false;

UPDATE "Bid" SET "transactionId" = 'unk' where "transactionId" is null;
ALTER TABLE "Bid" ALTER COLUMN "transactionId" SET NOT NULL;

ALTER TABLE "BidRecurring" ADD COLUMN "isPaused" boolean not null default false;

ALTER TABLE "Bid" ADD COLUMN "isRefunded" boolean not null default false;

ALTER TABLE "Auction"
  ADD COLUMN "validFrom" TIMESTAMP(3),
  ADD COLUMN "validTo" TIMESTAMP(3);
UPDATE "Auction" SET "validFrom" = "endAt" where "validFrom" is null;
UPDATE "Auction" SET "validTo" = "endAt" + interval '1d' where "validTo" is null;
ALTER TABLE "Auction"
  ALTER COLUMN "validFrom" SET NOT NULL,
  ALTER COLUMN "validTo" SET NOT NULL;
