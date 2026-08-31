-- ChallengeJudge.userSelectable: DB-driven "offer this judge to users in the create form".
-- Applied manually per environment. Seed the two historically-whitelisted judges so the
-- switch to a DB-driven filter is behaviour-preserving; the app also falls back to the
-- USER_SELECTABLE_JUDGE_NAMES name whitelist when no row has userSelectable = true.
ALTER TABLE "ChallengeJudge" ADD COLUMN "userSelectable" BOOLEAN NOT NULL DEFAULT false;

UPDATE "ChallengeJudge" SET "userSelectable" = true WHERE name IN ('CivBot', 'CivChan');
