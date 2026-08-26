CREATE TABLE "Blurb" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "name" CITEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    CONSTRAINT "Blurb_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BlurbReference" (
    "blurbId" INTEGER NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "materializedHash" TEXT NOT NULL,
    "materializedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "BlurbReference_pkey" PRIMARY KEY ("blurbId", "entityType", "entityId")
);

CREATE UNIQUE INDEX "Blurb_userId_name_key" ON "Blurb"("userId", "name");
CREATE INDEX "Blurb_updatedAt_idx" ON "Blurb"("updatedAt");
CREATE INDEX "BlurbReference_entityType_entityId_idx" ON "BlurbReference"("entityType", "entityId");
CREATE INDEX "BlurbReference_materializedAt_idx" ON "BlurbReference"("materializedAt");

ALTER TABLE "Blurb" ADD CONSTRAINT "Blurb_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlurbReference" ADD CONSTRAINT "BlurbReference_blurbId_fkey"
  FOREIGN KEY ("blurbId") REFERENCES "Blurb"("id") ON DELETE CASCADE ON UPDATE CASCADE;
