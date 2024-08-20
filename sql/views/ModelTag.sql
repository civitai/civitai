 WITH model_tags AS (
         SELECT "TagsOnModels"."modelId",
            "TagsOnModels"."tagId",
            5 AS score,
            1 AS "upVotes",
            0 AS "downVotes"
           FROM "TagsOnModels"
        UNION
         SELECT "TagsOnModelsVote"."modelId",
            "TagsOnModelsVote"."tagId",
            sum("TagsOnModelsVote".vote) AS score,
            sum(iif(("TagsOnModelsVote".vote > 0), 1, 0)) AS "upVotes",
            sum(iif(("TagsOnModelsVote".vote < 0), 1, 0)) AS "downVotes"
           FROM "TagsOnModelsVote"
          GROUP BY "TagsOnModelsVote"."tagId", "TagsOnModelsVote"."modelId"
        )
 SELECT mt."modelId",
    mt."tagId",
    sum(mt.score) AS score,
    sum(mt."upVotes") AS "upVotes",
    sum(mt."downVotes") AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType"
   FROM (model_tags mt
     JOIN "Tag" t ON ((t.id = mt."tagId")))
  GROUP BY mt."modelId", mt."tagId", t.name, t.type;