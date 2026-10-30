-- The judging engine becomes an attribute of the JUDGE. A challenge copies it at creation time;
-- nothing reads this column again once the challenge exists.
-- Applied MANUALLY (this repo never runs `prisma migrate deploy`).
--
-- Backwards compatible on its own: every existing judge defaults to "legacy-absolute", which is
-- the path they already run, and the create paths omit the Challenge column entirely when the
-- resolved engine is the default — so an unapplied migration leaves creation exactly as it was.
--
-- Re-runnable: the single statement is IF NOT EXISTS.
--
-- No new constraint, index or foreign key, by decision. The value is validated in application
-- code (`isJudgingEngineKey`), which falls back to "legacy-absolute" for anything it does not
-- recognise. A CHECK constraint would instead make deleting a retired engine key a migration
-- that can fail on live rows, and there is no query that filters or joins on this column —
-- it is read once, by primary key, on the judge row a challenge is being created against.

ALTER TABLE "ChallengeJudge"
  ADD COLUMN IF NOT EXISTS "judgingEngine" VARCHAR(50) NOT NULL DEFAULT 'legacy-absolute';
