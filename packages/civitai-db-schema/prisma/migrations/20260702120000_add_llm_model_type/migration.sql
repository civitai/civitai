-- Add the LLM value to the ModelType enum so users can publish Large Language
-- models as a first-class model type (alongside the recently-added CLIP and
-- VisionLanguage types).
--
-- NOTE: In PostgreSQL a newly added enum value cannot be used in the same
-- transaction that adds it. Apply this statement on its own (it is not wrapped
-- in BEGIN/COMMIT here). Per repo convention, migrations are applied manually.
ALTER TYPE "ModelType" ADD VALUE IF NOT EXISTS 'LLM';
