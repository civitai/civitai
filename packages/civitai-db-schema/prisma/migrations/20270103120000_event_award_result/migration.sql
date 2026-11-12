-- Write-once team awards (Crucible placements, won flags). Additive: a new empty table.
CREATE TABLE "EventAwardResult" (
  "id" SERIAL NOT NULL,
  "event" TEXT NOT NULL,
  "sourceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "team" TEXT,
  "points" INTEGER NOT NULL,
  "at" TIMESTAMPTZ(3) NOT NULL,
  "inputs" JSONB NOT NULL,
  "frozenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "voidedAt" TIMESTAMPTZ(3),
  CONSTRAINT "EventAwardResult_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EventAwardResult_event_sourceId_key" ON "EventAwardResult"("event", "sourceId");
