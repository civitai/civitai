-- Create a temp table to hold comment counts per thread
SELECT "threadId", COUNT(*) AS count
INTO temp_comment_counts
FROM "CommentV2"
GROUP BY "threadId";
---

-- Optional: index the temp table for fast join lookup
CREATE INDEX ON temp_comment_counts("threadId");
---
-- Update Thread.commentCount in batches
DO $$
DECLARE
  batch_size int := 10000;
  last_id int := 0;
  max_id int;
  updated_count int;
BEGIN
  SELECT max("threadId") INTO max_id FROM temp_comment_counts;

  WHILE last_id < max_id LOOP
    UPDATE "Thread" t
    SET "commentCount" = tmp.count
    FROM temp_comment_counts tmp
    WHERE t.id = tmp."threadId"
      AND tmp."threadId" > last_id
      AND tmp."threadId" <= last_id + batch_size;

    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RAISE NOTICE 'Updated threads % - % (% rows)', last_id + 1, last_id + batch_size, updated_count;

    COMMIT;
    last_id := last_id + batch_size;
  END LOOP;

  RAISE NOTICE 'All batches complete. Max threadId = %', max_id;
END$$;
---
-- Create trigger function to keep comment counts updated
CREATE OR REPLACE FUNCTION update_thread_comment_count()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE "Thread" SET "commentCount" = "commentCount" + 1 WHERE id = NEW."threadId";
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE "Thread" SET "commentCount" = "commentCount" - 1 WHERE id = OLD."threadId";
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to keep comment counts updated
CREATE TRIGGER comment_count_update
AFTER INSERT OR DELETE ON "CommentV2"
FOR EACH ROW EXECUTE FUNCTION update_thread_comment_count();
---
-- Clean up temp table
DROP TABLE temp_comment_counts;
