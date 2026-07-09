-- Improve ImageTag view
CREATE OR REPLACE VIEW "ImageTag" AS
SELECT
  it."imageId",
  it."tagId",
  COALESCE(toi.automated, FALSE) AS automated,
  COALESCE(toi.confidence, 0) AS confidence,
  COALESCE(10 * toi.confidence / 100, 0::numeric) + COALESCE(v.score, 0::numeric) AS score,
  COALESCE(v."upVotes", 0) AS "upVotes",
  COALESCE(v."downVotes", 0) AS "downVotes",
  t.name AS "tagName",
  t.type AS "tagType",
  t.nsfw AS "tagNsfw",
  t."nsfwLevel" AS "tagNsfwLevel",
  COALESCE(toi."needsReview", FALSE) AS "needsReview",
  TRUE AS concrete,  -- Concrete used to be NOT disabled, disabled records are already filtered out so concrete is always TRUE
  v."lastUpvote",
  COALESCE(toi.source, 'User'::"TagSource") AS source
FROM (
       SELECT
         toi."imageId",
         toi."tagId"
       FROM "TagsOnImage" toi

       UNION

       SELECT
         toiv."imageId",
         toiv."tagId"
       FROM "TagsOnImageVote" toiv
       ) it -- ImageTags
     LEFT JOIN  "TagsOnImage" toi ON it."imageId" = toi."imageId" AND it."tagId" = toi."tagId"
     CROSS JOIN LATERAL (
                  SELECT
                    SUM("v".vote) AS score,
                    SUM(iif("v".vote > 0, 1, 0)) AS "upVotes",
                    SUM(iif("v".vote < 0, 1, 0)) AS "downVotes",
                    MAX(iif("v".vote > 0, "v"."createdAt", NULL::timestamp WITHOUT TIME ZONE)) AS "lastUpvote"
                  FROM "TagsOnImageVote" v
                  WHERE
                      v."imageId" = it."imageId"
                  AND v."tagId" = it."tagId"
                  ) v -- Votes
-- Join the tag through a lateral join with a limit of 1 to hint to Postgres to do this at the end
     CROSS JOIN LATERAL (
                  SELECT *
                  FROM "Tag" t
                  WHERE
                    t."id" = it."tagId"
                  LIMIT 1
                  ) t -- Tag
WHERE
    t.unlisted IS FALSE
AND (toi.disabled IS NULL OR toi.disabled = FALSE)
;

-- Add index to chatmember
CREATE INDEX "ChatMember_userId_status_muted_idx" ON "ChatMember" ("userId", "status", "isMuted");
-- CREATE INDEX CONCURRENTLY "ChatMember_userId_status_muted_idx" ON "ChatMember" ("userId", "status", "isMuted");

-- WHY?
-- CREATE INDEX CONCURRENTLY ON EntityMetric (entityId, metricType)
