-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- Postgres and is not rolled back, so run this statement on its own.
ALTER TYPE "ModelType" ADD VALUE IF NOT EXISTS 'ComfyWorkflows';
