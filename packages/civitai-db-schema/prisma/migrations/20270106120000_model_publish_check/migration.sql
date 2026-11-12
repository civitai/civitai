-- Pre-publish gate log: one row per check per run. Applied by hand.
CREATE TABLE IF NOT EXISTS "ModelPublishCheck" (
  "id" SERIAL NOT NULL,
  "modelId" INTEGER NOT NULL,
  "modelVersionId" INTEGER,
  "runId" TEXT NOT NULL,
  "check" TEXT NOT NULL,
  "outcome" TEXT NOT NULL,
  "detail" JSONB,
  "actorId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ModelPublishCheck_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ModelPublishCheck_modelId_createdAt_idx"
  ON "ModelPublishCheck" ("modelId", "createdAt" DESC);

-- The resolver's queue (waitingGatesSql) reads only these rows; the predicate must match its subquery.
CREATE INDEX IF NOT EXISTS "ModelPublishCheck_waiting_gate_idx"
  ON "ModelPublishCheck" ("modelId")
  WHERE "check" = 'gate' AND (outcome = 'pending' OR detail->>'scheduled' = 'true');
