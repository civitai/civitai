-- Width-agnostic storage for the cosmetic perceptual hash, plus a record of
-- which algorithm produced each one.
--
-- `pHash BIGINT` can only ever hold 64 bits, and 64 bits is measurably too few:
-- against the 950 hashed cosmetics on 2026-08-14, the two badges reported as
-- imitations of official artwork sat at Hamming 17 and 22 out of 64, inside a
-- corpus whose 1st percentile is 17 — i.e. no threshold separates them. `pHashHex`
-- is TEXT so a wider hash needs a re-hash and a version bump, not a migration.
--
-- `pHashVersion` names the lane: hashes from different algorithms are
-- statistically independent, and comparing across them yields noise with nothing
-- to signal it. The sweep job re-hashes any row whose version is not the one the
-- app currently asks for, which is how a width upgrade drains the corpus.
--
-- The seed converts the existing BIGINT to the same lowercase hex the
-- orchestrator originally returned (verified against live `mediaHash` output for
-- cosmetics 107 and 870), so no row needs re-hashing to adopt the new columns.
--
-- Applied manually per environment; re-runnable.
-- `pHashCheckedAt` records when the sweep last TRIED, success or failure. Without
-- it, artwork that can never be hashed (three cosmetics point at dead CDN objects)
-- matches the sweep's predicate forever and is retried every tick ahead of rows
-- that would succeed.
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "pHashHex" TEXT;
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "pHashVersion" TEXT;
ALTER TABLE "Cosmetic" ADD COLUMN IF NOT EXISTS "pHashCheckedAt" TIMESTAMP(3);

UPDATE "Cosmetic"
SET "pHashHex" = lpad(to_hex("pHash"), 16, '0'),
    "pHashVersion" = 'perceptual/64'
WHERE "pHash" IS NOT NULL
  AND "pHashHex" IS NULL;
