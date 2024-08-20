 SELECT m.id AS "modelId",
    mv.id AS "modelVersionId",
    true AS covered
   FROM ("ModelVersion" mv
     JOIN "Model" m ON ((m.id = mv."modelId")))
  WHERE ((mv.id = ANY (ARRAY[164821, 128713, 128078, 391999, 424706, 106916, 250712, 250708, 691639, 699279, 699332])) OR ((mv."baseModel" = ANY (ARRAY['SD 1.5'::text, 'SD 1.4'::text, 'SD 1.5 LCM'::text, 'SDXL 0.9'::text, 'SDXL 1.0'::text, 'SDXL 1.0 LCM'::text, 'Pony'::text, 'Flux.1 D'::text])) AND (NOT m.poi) AND ((mv.status = 'Published'::"ModelStatus") OR (m.availability = 'Private'::"Availability")) AND (m."allowCommercialUse" && ARRAY['RentCivit'::"CommercialUse", 'Rent'::"CommercialUse", 'Sell'::"CommercialUse"]) AND (((m.type = 'Checkpoint'::"ModelType") AND (mv."baseModelType" = 'Standard'::text) AND (mv.id IN ( SELECT "CoveredCheckpointDetails".version_id
           FROM "CoveredCheckpointDetails"))) OR (m.type = 'LORA'::"ModelType") OR (m.type = 'TextualInversion'::"ModelType") OR (m.type = 'VAE'::"ModelType") OR (m.type = 'LoCon'::"ModelType") OR (m.type = 'DoRA'::"ModelType")) AND (EXISTS ( SELECT 1
           FROM "ModelFile" mf
          WHERE ((mf."modelVersionId" = mv.id) AND (mf."scannedAt" IS NOT NULL) AND (mf.type = ANY (ARRAY['Model'::text, 'Pruned Model'::text, 'Negative'::text, 'VAE'::text])))))));