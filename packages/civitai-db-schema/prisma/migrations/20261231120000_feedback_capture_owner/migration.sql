-- The system account that owns feedback page captures (FEEDBACK_CAPTURE_OWNER_ID in
-- packages/civitai-shared/src/feedback-capture.ts), so a capture never counts against its reporter.
-- No email and no linked account, so nobody can sign in as it. Applied by hand.
BEGIN;

DO $$
DECLARE existing text;
BEGIN
  SELECT "username" INTO existing FROM "User" WHERE "id" = -2;
  IF existing IS NOT NULL AND existing IS DISTINCT FROM 'civitai-feedback-captures' THEN
    RAISE EXCEPTION 'User -2 already exists as %; pick another FEEDBACK_CAPTURE_OWNER_ID', existing;
  END IF;
END $$;

INSERT INTO "User" ("id", "username", "rewardsEligibility", "excludeFromLeaderboards")
VALUES (-2, 'civitai-feedback-captures', 'Ineligible', true)
ON CONFLICT ("id") DO NOTHING;

COMMIT;

-- After applying: one row, id -2.
SELECT "id", "username" FROM "User" WHERE "username" = 'civitai-feedback-captures';
