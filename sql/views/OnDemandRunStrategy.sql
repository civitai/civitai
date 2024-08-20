 SELECT p.id AS "partnerId",
    mv.id AS "modelVersionId",
    replace(replace(replace(p."onDemandStrategy", '{downloadUrl}'::text, 'https://civitai.com/api/download/models/{modelVersionId}'::text), '{modelVersionId}'::text, (mv.id)::text), '{modelId}'::text, (mv."modelId")::text) AS url
   FROM (("ModelVersion" mv
     JOIN "Model" m ON (((m.id = mv."modelId") AND (m.status = 'Published'::"ModelStatus"))))
     JOIN "Partner" p ON (((p."onDemand" = true) AND (p."onDemandStrategy" IS NOT NULL) AND (m.type = ANY (p."onDemandTypes")) AND (mv."baseModel" = ANY (p."onDemandBaseModels")))))
  WHERE (((p.nsfw = true) OR (m.nsfw = false)) AND (m.poi = false) AND (p.personal OR (m."allowCommercialUse" && ARRAY['Rent'::"CommercialUse", 'Sell'::"CommercialUse"])));