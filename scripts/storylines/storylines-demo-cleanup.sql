-- Removes the demo storyline created by storylines-demo-seed.sql. DEV ONLY.
--
--   node .claude/skills/postgres-query/query.mjs --dev --writable --file scripts/storylines/storylines-demo-cleanup.sql
--
-- Deletes only the "Storyline" row; its chapters, edges and collaborators go with it by
-- cascade. The posts the chapters point at are untouched.

DO $$
DECLARE
  removed int;
BEGIN
  IF coalesce(current_setting('cluster_name', true), '') NOT LIKE '%-dev' THEN
    RAISE EXCEPTION 'storylines demo cleanup: refusing to run, cluster_name is "%" (expected *-dev)',
      coalesce(current_setting('cluster_name', true), '');
  END IF;

  DELETE FROM "Storyline"
  WHERE title = 'The Patch'
    AND "userId" = (SELECT id FROM "User" WHERE username = 'CivBot');
  GET DIAGNOSTICS removed = ROW_COUNT;
  RAISE NOTICE 'storylines demo cleanup: removed % storyline(s)', removed;
END
$$;

SELECT count(*) AS "remainingDemoStorylines"
FROM "Storyline"
WHERE title = 'The Patch' AND "userId" = (SELECT id FROM "User" WHERE username = 'CivBot');
