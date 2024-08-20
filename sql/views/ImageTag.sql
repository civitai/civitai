 WITH image_tags AS (
         SELECT toi."imageId",
            toi."tagId",
            toi.automated,
            toi.confidence,
            ((10 * toi.confidence) / 100) AS score,
            0 AS "upVotes",
            0 AS "downVotes",
            toi."needsReview",
            toi.disabled,
            (NOT toi.disabled) AS concrete,
            NULL::timestamp without time zone AS "lastUpvote",
            toi.source
           FROM "TagsOnImage" toi
        UNION
         SELECT "TagsOnImageVote"."imageId",
            "TagsOnImageVote"."tagId",
            false AS automated,
            0 AS confidence,
            sum("TagsOnImageVote".vote) AS score,
            sum(iif(("TagsOnImageVote".vote > 0), 1, 0)) AS "upVotes",
            sum(iif(("TagsOnImageVote".vote < 0), 1, 0)) AS "downVotes",
            false AS "needReview",
            false AS disabled,
            false AS concrete,
            max(iif(("TagsOnImageVote".vote > 0), "TagsOnImageVote"."createdAt", NULL::timestamp without time zone)) AS "lastUpvote",
            NULL::"TagSource" AS source
           FROM "TagsOnImageVote"
          GROUP BY "TagsOnImageVote"."tagId", "TagsOnImageVote"."imageId"
        )
 SELECT it."imageId",
    it."tagId",
    bool_or(it.automated) AS automated,
    max(it.confidence) AS confidence,
    COALESCE(sum(it.score), (0)::numeric) AS score,
    max(it."upVotes") AS "upVotes",
    max(it."downVotes") AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType",
    t.nsfw AS "tagNsfw",
    t."nsfwLevel" AS "tagNsfwLevel",
    bool_or(it."needsReview") AS "needsReview",
    bool_or(it.concrete) AS concrete,
    max(it."lastUpvote") AS "lastUpvote",
    COALESCE(max(it.source), 'User'::"TagSource") AS source
   FROM (image_tags it
     JOIN "Tag" t ON (((t.id = it."tagId") AND (NOT t.unlisted))))
  GROUP BY it."imageId", it."tagId", t.name, t.type, t.nsfw, t."nsfwLevel"
 HAVING (bool_or(it.disabled) = false);