 WITH post_tags AS (
         SELECT toi."postId",
            toi."tagId",
            5 AS score,
            0 AS "upVotes",
            0 AS "downVotes"
           FROM "TagsOnPost" toi
          WHERE (NOT toi.disabled)
        UNION
         SELECT "TagsOnPostVote"."postId",
            "TagsOnPostVote"."tagId",
            sum("TagsOnPostVote".vote) AS score,
            sum(iif(("TagsOnPostVote".vote > 0), 1, 0)) AS "upVotes",
            sum(iif(("TagsOnPostVote".vote < 0), 1, 0)) AS "downVotes"
           FROM "TagsOnPostVote"
          GROUP BY "TagsOnPostVote"."tagId", "TagsOnPostVote"."postId"
        )
 SELECT pt."postId",
    pt."tagId",
    sum(pt.score) AS score,
    max(pt."upVotes") AS "upVotes",
    max(pt."downVotes") AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType"
   FROM (post_tags pt
     JOIN "Tag" t ON ((t.id = pt."tagId")))
  GROUP BY pt."postId", pt."tagId", t.name, t.type;