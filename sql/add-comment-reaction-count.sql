
-- =====================================================
-- Backfill existing reaction counts
-- =====================================================

-- Create a temp table to hold reaction counts per comment
SELECT "commentId", COUNT(*) AS count
INTO temp_reaction_counts
FROM "CommentV2Reaction"
GROUP BY "commentId";

-- Optional: index the temp table for fast join lookup
CREATE INDEX ON temp_reaction_counts("commentId");

-- Update CommentV2.reactionCount in batches
DO $$
DECLARE
  batch_size int := 10000;
  last_id int := 0;
  max_id int;
  updated_count int;
BEGIN
  SELECT max("commentId") INTO max_id FROM temp_reaction_counts;

  RAISE NOTICE 'Starting backfill. Max commentId = %', max_id;

  WHILE last_id < max_id LOOP
    UPDATE "CommentV2" c
    SET "reactionCount" = tmp.count
    FROM temp_reaction_counts tmp
    WHERE c.id = tmp."commentId"
      AND tmp."commentId" > last_id
      AND tmp."commentId" <= last_id + batch_size;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Updated comments % - % (% rows)', last_id + 1, last_id + batch_size, updated_count;

    COMMIT;
    last_id := last_id + batch_size;
  END LOOP;

  RAISE NOTICE 'All batches complete. Max commentId = %', max_id;
END$$;

-- Clean up temp table
DROP TABLE temp_reaction_counts;
