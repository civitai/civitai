CREATE OR REPLACE FUNCTION update_post_nsfw_levels(post_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
  WITH post_nsfw_level AS (
	  SELECT DISTINCT ON (p.id) p.id, i.nsfw
		FROM "Post" p
		JOIN "Image" i ON i."postId" = p.id
		WHERE p.id = ANY(post_ids)
		ORDER BY p.id, i.index
	)
	UPDATE "Post" p
	SET
	  metadata = CASE
       WHEN jsonb_typeof(metadata) = 'null' OR metadata IS NULL THEN jsonb_build_object('imageNsfw', COALESCE(pnl.nsfw, 'None'))
       ELSE p.metadata || jsonb_build_object('imageNsfw', COALESCE(pnl.nsfw, 'None'))
	  END
	FROM post_nsfw_level pnl
	WHERE pnl.id = p.id;
END;
$$ LANGUAGE plpgsql;
---
CREATE OR REPLACE FUNCTION update_post_nsfw_level(VARIADIC post_ids INTEGER[])
RETURNS VOID AS $$
BEGIN
	PERFORM update_post_nsfw_levels(post_ids);
END;
$$ LANGUAGE plpgsql;
