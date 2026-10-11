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
-- wording changes.
UPDATE "Cosmetic" c SET name = 'Special Achievement Badge ' || v.n,
  description = 'Earned a special Creator Journey achievement.'
FROM (VALUES (2900, 1), (2899, 2), (2895, 3), (2894, 4), (2896, 5), (2901, 6), (2897, 7), (2898, 8))
  AS v(id, n)
WHERE c.id = v.id
  AND c.name = 'Hidden Achievement Badge ' || v.n
  AND c.description = 'Earned a hidden Creator Journey achievement.';
