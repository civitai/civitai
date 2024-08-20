 SELECT rr.id AS "resourceReviewId",
    count(DISTINCT i.id) AS "imageCount"
   FROM (("ResourceReview" rr
     JOIN "ImageResource" ir ON ((ir."modelVersionId" = rr."modelVersionId")))
     JOIN "Image" i ON (((i.id = ir."imageId") AND (i."userId" = rr."userId"))))
  WHERE (ir."modelVersionId" = rr."modelVersionId")
  GROUP BY rr.id;