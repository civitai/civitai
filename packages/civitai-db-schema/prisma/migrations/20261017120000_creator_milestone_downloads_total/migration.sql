-- The Downloads track counts a creator's total downloads across their published models, not the
-- downloads of their best single model. Each UPDATE matches only the old text, so a re-run, or a
-- row edited since, is left alone.
UPDATE "CreatorMilestone" SET description = 'Your models reached 100 downloads in total.'
WHERE key = 'reach:downloads-100' AND description = 'One of your models reached 100 downloads.';
UPDATE "CreatorMilestone" SET description = 'Your models reached 1,000 downloads in total.'
WHERE key = 'reach:downloads-1000' AND description = 'One of your models reached 1,000 downloads.';
UPDATE "CreatorMilestone" SET description = 'Your models reached 10,000 downloads in total.'
WHERE key = 'reach:downloads-10000' AND description = 'One of your models reached 10,000 downloads.';
UPDATE "CreatorMilestone" SET description = 'Your models reached 100,000 downloads in total.'
WHERE key = 'reach:downloads-100000' AND description = 'One of your models reached 100,000 downloads.';
UPDATE "CreatorMilestone" SET description = 'Your models reached 1,000,000 downloads in total.'
WHERE key = 'reach:downloads-1000000' AND description = 'One of your models reached 1,000,000 downloads.';

-- The special-achievement badges keep their numbered, non-descriptive names; only the old "hidden"
-- wording changes. Each row is matched by its own old name and old description, and only official
-- cosmetics, since a creator can name their own anything.
UPDATE "Cosmetic"
SET name = 'Special Achievement Badge ' || substring(name FROM '[0-9]+$'),
  description = 'Earned a special Creator Journey achievement.'
WHERE name ~ '^Hidden Achievement Badge [0-9]+$'
  AND description = 'Earned a hidden Creator Journey achievement.'
  AND "createdById" IS NULL;
