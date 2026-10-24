-- Users who opted in to listing their image reactions from before "who reacted" lists launched
-- (User.settings.showPreLaunchReactions). The reactor-list queries read this set once per request
-- (an InitPlan); without the index that is a parallel seq scan of "User" (~2.8s on prod).
--
-- MANUAL APPLY: the main DB does not auto-apply migrations. Apply per environment (dev, then prod)
-- BEFORE the code that reads it ships. Additive; nothing deployed today reads the key.
--
-- The predicate must match the query text exactly (key as a literal) for the planner to use it.
-- RUN OUTSIDE ANY TRANSACTION (CONCURRENTLY). A failed build leaves an INVALID index:
-- DROP INDEX IF EXISTS "User_showPreLaunchReactions_idx", then re-run.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "User_showPreLaunchReactions_idx"
  ON "User" (id)
  WHERE settings -> 'showPreLaunchReactions'::text = 'true'::jsonb;
