-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "unfeatured" BOOLEAN NOT NULL DEFAULT false;

-- Update feature image function
CREATE OR REPLACE FUNCTION feature_images(num_images_per_category integer)
RETURNS void AS $$
BEGIN
    WITH image_score AS (
        SELECT
          i.id,
          t.name category,
          (
            stat."reactionCountAllTime" * 0.3 +
            stat."likeCountAllTime" * 1 +
            stat."heartCountAllTime" * 1.3 +
            stat."laughCountAllTime" * 0.5 +
            stat."cryCountAllTime" * 0.3 +
            stat."dislikeCountAllTime" * -1 +
            stat."commentCountAllTime" * 1.3
          ) score
        FROM "Image" i
        JOIN "TagsOnImage" toi ON toi."imageId" = i.id
        JOIN "Tag" t ON toi."tagId" = t.id AND t."isCategory" = true AND NOT t."unfeatured"
        JOIN "ImageStat" stat ON stat."imageId" = i.id
        WHERE i.nsfw = false AND i."featuredAt" IS NULL
    ), to_feature AS (
        SELECT
          id
        FROM (
            SELECT
              id,
              row_number() OVER (PARTITION BY category ORDER BY score DESC) featured_rank
            FROM image_score
        ) ranked
        WHERE featured_rank <= num_images_per_category
    )
    UPDATE "Image" i SET "featuredAt" = now()
    FROM to_feature tf
    WHERE i.id = tf.id;
END;
$$ LANGUAGE plpgsql;