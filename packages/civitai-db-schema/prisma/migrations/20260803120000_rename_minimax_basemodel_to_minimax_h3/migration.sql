-- The MiniMax ecosystem was onboarded as a vendor-level key ('MiniMax') rather
-- than a model-family key, so a future Hailuo release would have no name left to
-- take. Renamed to 'MiniMaxH3' / 'MiniMax H3' in basemodel.constants.ts; this
-- moves the already-persisted rows to match.
--
-- Scope at time of writing: 1 ModelVersion (3183239, the CivitaiOfficial
-- generation target) and its derived metric row. The base model is hidden:true
-- and has no training support entry, so no user-uploaded or trained rows exist.
UPDATE "ModelVersion"
SET "baseModel" = 'MiniMax H3'
WHERE "baseModel" = 'MiniMax';

UPDATE "ModelBaseModelMetric"
SET "baseModel" = 'MiniMax H3'
WHERE "baseModel" = 'MiniMax';
