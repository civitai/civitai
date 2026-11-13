-- Idempotent: applied by hand, possibly more than once.
--
-- A model's licensing permissions over time, so a merge is judged by the permission in effect when it
-- was made. Apply BEFORE deploying: upsertModel writes to it inside the model-save transaction, so a
-- missing table fails every permission change. Then run the backfill route
-- (/api/admin/temp/backfill-model-permission-snapshots) to rebuild history from ClickHouse.

CREATE TABLE IF NOT EXISTS "ModelPermissionSnapshot" (
  "id" SERIAL NOT NULL,
  "modelId" INTEGER NOT NULL,
  "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "actorUserId" INTEGER,
  "actorRole" TEXT,
  "allowNoCredit" BOOLEAN NOT NULL,
  "allowCommercialUse" "CommercialUse"[] NOT NULL,
  "allowDerivatives" BOOLEAN NOT NULL,
  "allowDifferentLicense" BOOLEAN NOT NULL,
  CONSTRAINT "ModelPermissionSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModelPermissionSnapshot_modelId_effectiveAt_idx"
  ON "ModelPermissionSnapshot" ("modelId", "effectiveAt");

DO $$ BEGIN
  ALTER TABLE "ModelPermissionSnapshot" ADD CONSTRAINT "ModelPermissionSnapshot_modelId_fkey"
    FOREIGN KEY ("modelId") REFERENCES "Model"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
