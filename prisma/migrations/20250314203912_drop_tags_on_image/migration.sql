DROP FUNCTION IF EXISTS feature_images(text,integer);
DROP FUNCTION IF EXISTS feature_images(integer);

-- Improve ImageTag view
CREATE OR REPLACE VIEW "ImageTag" AS
 SELECT it."imageId",
    it."tagId",
    toi.automated AS automated,
    toi.confidence AS confidence,
    COALESCE((10 * toi.confidence / 100)::numeric, 0::numeric) + COALESCE(v.score::numeric, 0::numeric) AS score,
    COALESCE(v."upVotes", 0::bigint) AS "upVotes",
    COALESCE(v."downVotes", 0::bigint) AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType",
    t.nsfw AS "tagNsfw",
    t."nsfwLevel" AS "tagNsfwLevel",
    toi."needsReview" AS "needsReview",
    true AS concrete,
    v."lastUpvote",
   toi.source AS source
   FROM ( SELECT toi_1."imageId",
            toi_1."tagId"
           FROM "TagsOnImageDetails" toi_1
        UNION
         SELECT toiv."imageId",
            toiv."tagId"
           FROM "TagsOnImageVote" toiv) it
     LEFT JOIN "TagsOnImageDetails" toi ON it."imageId" = toi."imageId" AND it."tagId" = toi."tagId"
     CROSS JOIN LATERAL ( SELECT sum(v_1.vote) AS score,
            sum(iif(v_1.vote > 0, 1, 0)) AS "upVotes",
            sum(iif(v_1.vote < 0, 1, 0)) AS "downVotes",
            max(iif(v_1.vote > 0, v_1."createdAt", NULL::timestamp without time zone)) AS "lastUpvote"
           FROM "TagsOnImageVote" v_1
          WHERE v_1."imageId" = it."imageId" AND v_1."tagId" = it."tagId") v
     CROSS JOIN LATERAL ( SELECT t_1.name,
            t_1.color,
            t_1."createdAt",
            t_1."updatedAt",
            t_1.id,
            t_1.target,
            t_1.unlisted,
            t_1."isCategory",
            t_1.unfeatured,
            t_1.type,
            t_1.nsfw,
            t_1."adminOnly",
            t_1."nsfwLevel"
           FROM "Tag" t_1
          WHERE t_1.id = it."tagId"
         LIMIT 1) t
  WHERE t.unlisted IS FALSE AND NOT toi."disabled";


CREATE OR REPLACE VIEW "PostImageTag" AS
SELECT DISTINCT i."postId" AS post_id,
  toi."tagId" AS tag_id
FROM "TagsOnImageNew" toi
JOIN "Image" i ON i.id = toi."imageId";


-- DropForeignKey
ALTER TABLE "TagsOnImage" DROP CONSTRAINT "TagsOnImage_imageId_fkey";

-- DropForeignKey
ALTER TABLE "TagsOnImage" DROP CONSTRAINT "TagsOnImage_tagId_fkey";

-- DropForeignKey
ALTER TABLE "TagsOnImageNew" DROP CONSTRAINT "TagsOnImageNew_imageId_fkey";

-- DropTable
DROP TABLE "TagsOnImage";


