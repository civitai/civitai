-- Per-key buzz spending limits (JSON: { daily?: number, weekly?: number, monthly?: number })
ALTER TABLE "ApiKey" ADD COLUMN "buzzLimit" JSONB;
