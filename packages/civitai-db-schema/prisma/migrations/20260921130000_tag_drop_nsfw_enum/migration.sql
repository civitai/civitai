-- 🔴 APPLY ONLY AFTER the build that stops selecting these columns is deployed everywhere.
--
-- Prisma selects an explicit column list, so a pod running an older build still asks for
-- "Tag"."nsfw" (`collection.service.ts` and `post.service.ts` read the whole Tag row via
-- `include: { tag: true }`) and for "ImageTag"."tagNsfw". Running this under them errors.
--
-- The view has to be recreated first: a plain DROP COLUMN fails with
--   cannot drop column nsfw of table "Tag" because other objects depend on it
-- and CASCADE would take the view with it. CREATE OR REPLACE VIEW cannot drop an output
-- column, so this is a DROP + CREATE; the body is otherwise byte-identical to the current
-- definition, minus the two nsfw lines. "ImageTag" is a view, so nothing is rewritten and
-- no data moves.
--
-- Order: 20260921120000_tag_nsfw_term (adds nsfwTerm, seeds from this column) → deploy →
-- this. A rollback past the deploy needs the column and the view column back:
--   ALTER TABLE "Tag" ADD COLUMN "nsfw" "NsfwLevel" NOT NULL DEFAULT 'None';
-- then recreate the view with `t.nsfw AS "tagNsfw"` restored. The 32 hand-set values do
-- not come back, which is why the seed runs first.
--
-- The NsfwLevel enum type itself stays: Image.nsfw still uses it.

DROP VIEW "ImageTag";

CREATE VIEW "ImageTag" AS
SELECT it."imageId",
    it."tagId",
    toi.automated,
    toi.confidence,
    COALESCE((10 * toi.confidence / 100)::numeric, 0::numeric) + COALESCE(v.score::numeric, 0::numeric) AS score,
    COALESCE(v."upVotes", 0::bigint) AS "upVotes",
    COALESCE(v."downVotes", 0::bigint) AS "downVotes",
    t.name AS "tagName",
    t.type AS "tagType",
    t."nsfwLevel" AS "tagNsfwLevel",
    toi."needsReview",
    true AS concrete,
    v."lastUpvote",
    toi.source
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
            t_1."adminOnly",
            t_1."nsfwLevel"
           FROM "Tag" t_1
          WHERE t_1.id = it."tagId" AND NOT t_1.unlisted
         LIMIT 1) t
  WHERE NOT toi.disabled;

ALTER TABLE "Tag" DROP COLUMN "nsfw";
