-- Seed the default judging rubric onto every challenge that has none (System + Mod challenges;
-- user-created challenges always store their own). Scoring and display run off judgingCategories,
-- so a NULL forced a second, hardcoded code path. Weights are the same 50/15/15/20 the fixed
-- rubric already applied, so no completed challenge's scores or recorded winners change.
--
-- label + criteria are read from ChallengeCategory rather than hardcoded, so each environment
-- seeds the text its own library holds. The row order (theme first) is the display order in the
-- judge-score popover.

WITH rubric AS (
  SELECT jsonb_agg(
           jsonb_build_object(
             'key', c.key,
             'label', c.label,
             'criteria', c.criteria,
             'weight', w.weight
           )
           ORDER BY w.sort_order
         ) AS categories,
         count(*) AS resolved
  FROM (VALUES
    ('theme', 50, 1),
    ('wittiness', 15, 2),
    ('humor', 15, 3),
    ('aesthetic', 20, 4)
  ) AS w(key, weight, sort_order)
  JOIN "ChallengeCategory" c ON c.key = w.key AND c.active
)
UPDATE "Challenge" ch
SET "judgingCategories" = rubric.categories
FROM rubric
WHERE ch."judgingCategories" IS NULL
  -- Abort rather than write a partial rubric if this environment's category library is unseeded.
  AND rubric.resolved = 4;
