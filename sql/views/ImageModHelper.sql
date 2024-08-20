 WITH image_analysis AS (
         SELECT "Image".id,
            (("Image".analysis -> 'porn'::text))::real AS porn,
            (("Image".analysis -> 'sexy'::text))::real AS sexy,
            (("Image".analysis -> 'hentai'::text))::real AS hentai,
            (("Image".analysis -> 'drawing'::text))::real AS drawing,
            (("Image".analysis -> 'neutral'::text))::real AS neutral
           FROM "Image"
          WHERE (("Image".analysis IS NOT NULL) AND (("Image".analysis ->> 'neutral'::text) <> '0'::text))
        )
 SELECT i.id AS "imageId",
    iif((ia.id IS NOT NULL), (((ia.porn + ia.hentai) + (ia.sexy / (2)::double precision)) > (0.6)::double precision), NULL::boolean) AS "assessedNSFW",
    COALESCE(reports.count, (0)::bigint) AS "nsfwReportCount"
   FROM (("Image" i
     LEFT JOIN image_analysis ia ON ((ia.id = i.id)))
     LEFT JOIN ( SELECT ir."imageId",
            count(DISTINCT r."userId") AS count
           FROM ("ImageReport" ir
             JOIN "Report" r ON ((r.id = ir."reportId")))
          WHERE (r.reason = 'NSFW'::"ReportReason")
          GROUP BY ir."imageId") reports ON ((reports."imageId" = i.id)));