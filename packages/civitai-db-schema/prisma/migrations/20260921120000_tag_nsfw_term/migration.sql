-- Whether the TERM is adult, as against `nsfwLevel`, which rates the content it marks. Additive on
-- purpose: two hot paths read the whole Tag row (`include: { tag: true }`), so retyping the existing
-- `nsfw` enum in place would break either the old build or the new one, and migrations are applied
-- by hand — there is no window where both work.
ALTER TABLE "Tag" ADD COLUMN "nsfwTerm" BOOLEAN NOT NULL DEFAULT false;

-- Seed from both sources: `nsfwLevel` at R and above (60 = R|X|XXX|Blocked), plus the 32 rows a
-- human set on the old enum. The level threshold is deliberately looser than the public-browsing
-- test elsewhere, which is PG only, so a PG-13 term seeds as not-adult.
UPDATE "Tag"
SET "nsfwTerm" = true
WHERE ("nsfwLevel" & 60) != 0
   OR "nsfw" IN ('Soft', 'Mature', 'X', 'Blocked');
