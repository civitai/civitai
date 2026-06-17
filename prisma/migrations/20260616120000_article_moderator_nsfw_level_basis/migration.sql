-- Snapshot of the content-derived NSFW level at the time `moderatorNsfwLevel`
-- was set. Powers the auto-approve "content actually dropped" gate (#6) in
-- evaluateAutoApproveGate. Nullable: null = no override, or a legacy override
-- predating this column (the gate fails closed on null → routes to the mod queue).
ALTER TABLE "Article" ADD COLUMN "moderatorNsfwLevelBasis" INTEGER;
