-- Index for pinned comments (Remember to run concurrently in production)
CREATE INDEX idx_commentv2_thread_pinned ON "CommentV2"("threadId", "pinnedAt" DESC) WHERE "pinnedAt" IS NOT NULL;
-- CREATE INDEX CONCURRENTLY idx_commentv2_thread_pinned ON "CommentV2"("threadId", "pinnedAt" DESC) WHERE "pinnedAt" IS NOT NULL;

-- =====================================================
-- Add reactionCount column to CommentV2 table
-- =====================================================
ALTER TABLE "CommentV2"
ADD COLUMN IF NOT EXISTS "reactionCount" INT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "CommentV2_reactionCount_id_idx" ON "CommentV2"("reactionCount" DESC, "id" DESC);
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS "CommentV2_reactionCount_id_idx" ON "CommentV2"("reactionCount" DESC, "id" DESC);

-- =====================================================
-- Create trigger function to maintain reaction counts
-- =====================================================
CREATE OR REPLACE FUNCTION update_comment_reaction_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "CommentV2"
    SET "reactionCount" = "reactionCount" + 1
    WHERE id = NEW."commentId";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "CommentV2"
    SET "reactionCount" = GREATEST("reactionCount" - 1, 0)
    WHERE id = OLD."commentId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- Add trigger to maintain reaction counts automatically
-- =====================================================

-- Drop existing trigger if it exists
DROP TRIGGER IF EXISTS comment_reaction_count_update ON "CommentV2Reaction";

-- Create new trigger
CREATE TRIGGER comment_reaction_count_update
AFTER INSERT OR DELETE ON "CommentV2Reaction"
FOR EACH ROW EXECUTE FUNCTION update_comment_reaction_count();
