-- CreateTable
CREATE TABLE "ComicProjectReference" (
    "projectId" INTEGER NOT NULL,
    "referenceId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ComicProjectReference_pkey" PRIMARY KEY ("projectId","referenceId")
);

-- CreateIndex
CREATE INDEX "ComicProjectReference_referenceId_idx" ON "ComicProjectReference"("referenceId");

-- AddForeignKeys
ALTER TABLE "ComicProjectReference" ADD CONSTRAINT "ComicProjectReference_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "ComicProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ComicProjectReference" ADD CONSTRAINT "ComicProjectReference_referenceId_fkey" FOREIGN KEY ("referenceId") REFERENCES "ComicReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
 
-- Backfill: associate all existing references with all existing projects for the same user
INSERT INTO "ComicProjectReference" ("projectId", "referenceId", "createdAt")
SELECT p."id", r."id", NOW()
FROM "ComicProject" p
JOIN "ComicReference" r ON r."userId" = p."userId"
ON CONFLICT DO NOTHING;
