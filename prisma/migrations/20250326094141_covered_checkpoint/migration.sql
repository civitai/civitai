-- auto-generated definition
create table if not exists "CoveredCheckpoint"
(
  model_id   integer not null,
  version_id integer
);

alter table "CoveredCheckpoint"
  alter column version_id set not null;

create unique index if not exists "CoveredCheckpoint_modelVersion"
  on "CoveredCheckpoint" (model_id, version_id);

alter table "CoveredCheckpoint"
  drop constraint if exists "CoveredCheckpoint_model_id_fkey";
alter table "CoveredCheckpoint"
  add constraint "CoveredCheckpoint_model_id_fkey"
    foreign key (model_id) references "Model" (id)
      on delete cascade
      on update cascade;

alter table "CoveredCheckpoint"
  drop constraint if exists "CoveredCheckpoint_version_id_fkey";
alter table "CoveredCheckpoint"
  add constraint "CoveredCheckpoint_version_id_fkey"
    foreign key (version_id) references "ModelVersion" (id)
      on delete cascade
      on update cascade;

-- driveby
CREATE INDEX IF NOT EXISTS "ChatMember_chatId_idx" ON "ChatMember" ("chatId");

create or replace view "GenerationCoverage"("modelId", "modelVersionId", covered) as
SELECT
  m.id  AS "modelId",
  mv.id AS "modelVersionId",
  true  AS covered
FROM "ModelVersion" mv
     JOIN "Model" m ON m.id = mv."modelId"
WHERE
   (mv.id = ANY
    (ARRAY [
      1475084, -- BiRefNet Background Removal
      164821, -- Remacri
      128713, -- DreamShaper
      128078, -- SDXL
      391999, -- SDXL Lightning LoRAs
      424706, -- LCM-LoRA Weights
      106916, -- Civitai Safe Helper
      250712, -- safe_neg
      250708, -- safe_pos
      691639, -- FLUX Dev
      699279, -- FLUX Schnell
      699332, -- FLUX Pro
      922358, -- FLUX Pro 1.1
      1088507, -- FLUX Pro 1.1 Ultra
      1003708, -- SD 3.5 Medium
      983309, -- SD 3.5 Large
      983611, -- SD 3.5 Large Turbo
      1190596, -- NoobAI-XL
      290640, -- Pony
      889818 -- Illustrious
      ]))
OR (mv."baseModel" = ANY
    (ARRAY ['SD 1.5'::text, 'SD 1.4'::text, 'SD 1.5 LCM'::text, 'SDXL 0.9'::text, 'SDXL 1.0'::text, 'SDXL 1.0 LCM'::text, 'Pony'::text, 'Flux.1 D'::text, 'Illustrious'::text, 'SD 3.5'::text, 'SD 3.5 Medium'::text, 'SD 3.5 Large'::text, 'SD 3.5 Large Turbo'::text, 'NoobAI'::text])) AND
   NOT m.poi AND
   (mv.status = 'Published'::"ModelStatus" OR m.availability = 'Private'::"Availability" OR m."uploadType" = 'Trained'::"ModelUploadType") AND
   m."allowCommercialUse" && ARRAY ['RentCivit'::"CommercialUse", 'Rent'::"CommercialUse", 'Sell'::"CommercialUse"] AND
   (m.type = 'Checkpoint'::"ModelType" AND mv."baseModelType" = 'Standard'::text AND (mv.id IN (
     SELECT
       "CoveredCheckpoint".version_id
     FROM "CoveredCheckpoint"
   )) OR m.type = 'LORA'::"ModelType" OR m.type = 'TextualInversion'::"ModelType" OR m.type = 'VAE'::"ModelType" OR m.type = 'LoCon'::"ModelType" OR
    m.type = 'DoRA'::"ModelType") AND (EXISTS (
    SELECT
      1
    FROM "ModelFile" mf
    WHERE
        mf."modelVersionId" = mv.id
    AND (mf."scannedAt" IS NOT NULL AND (mf.type = ANY (ARRAY ['Model'::text, 'Pruned Model'::text, 'Negative'::text, 'VAE'::text])) OR
         (mf.metadata -> 'trainingResults'::text) IS NOT NULL)
  ));
