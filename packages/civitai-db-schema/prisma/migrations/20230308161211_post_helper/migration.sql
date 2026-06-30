UPDATE "Tag" SET target = array_append(target, 'Post')
WHERE 'Image' = ANY(Target);


CREATE OR REPLACE VIEW "PostHelper" AS
SELECT
    "postId",
    bool_or("scannedAt" IS NOT NULL) AS scanned
FROM "Image"
GROUP BY "postId";