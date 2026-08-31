-- CU 868kk4j2k — restore payouts for versions whose licensing fee was cleared.
--
-- Setting a licensing fee also sets ModelVersionFlag.DisablePayout (bit 0) so the version opts out of
-- tips + creator compensation. Clearing the fee never stripped it, so those versions went on earning
-- nothing: no fee (it's gone) and no payouts (the bit is still set).
--
-- Measured before writing (2026-08-01, published + non-deleted): 176 versions across 134 creators.
--
-- ORDER MATTERS. Normalizing runs FIRST, while the flag still identifies the affected rows. Clearing
-- the flag first would leave the normalize statement matching every `licensingFee = 0` row — ~59k
-- versions that have no flag, earn normally, and are not part of this bug.

-- 1. The old clear path stored 0 instead of NULL. Normalize it on the stuck rows only, so later reads
--    (and the studio's "fee off" filter, which tests IS NULL) agree the fee is gone.
UPDATE "ModelVersion"
SET "licensingFee" = NULL,
    "licensingFeeType" = NULL,
    "licensingFeeSettlementCurrency" = NULL
WHERE "licensingFee" = 0
  AND ("flags" & 1) = 1;

-- 2. With no fee left to earn from, the opt-out has nothing to justify it. Versions that still carry a
--    fee keep the flag, as intended.
UPDATE "ModelVersion"
SET "flags" = "flags" & ~1
WHERE ("flags" & 1) = 1
  AND "licensingFee" IS NULL;
