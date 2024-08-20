 SELECT DISTINCT i."postId" AS post_id,
    toi."tagId" AS tag_id
   FROM ("TagsOnImage" toi
     JOIN "Image" i ON ((i.id = toi."imageId")));