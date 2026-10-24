-- Holds every ImageResourceNew row removed by /api/admin/temp/sweep-image-resources, so the sweep
-- can be reversed. Written in the same statement as each DELETE. No primary key: capturing the same
-- pair twice must never abort a delete. Drop once the sweep is confirmed.
CREATE TABLE IF NOT EXISTS "_sweep_irn_20260925" (
  "imageId" INTEGER NOT NULL,
  "modelVersionId" INTEGER NOT NULL,
  "strength" INTEGER,
  "detected" BOOLEAN NOT NULL,
  "tier" TEXT NOT NULL,
  "sweptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
