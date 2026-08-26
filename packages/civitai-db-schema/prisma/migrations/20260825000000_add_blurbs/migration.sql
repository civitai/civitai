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
    -- Set when the referenced blurb is edited or soft-deleted, cleared once the entity has been
    -- rewritten. This is what the fan-out selector filters on.
    --
    -- It exists because the obvious predicate cannot be indexed: staleness is
    -- r."materializedHash" <> b."contentHash", a CROSS-TABLE inequality, so no index on
    -- BlurbReference can evaluate it and the planner estimates it at selectivity 1.0. Every plan
    -- shape is then linear in the whole table, on a job that runs every 5 minutes whether or not
    -- there is work — measured at 3.7s and 3.5M buffers to return ZERO rows on a 1.2M-row table of
    -- the same shape.
    "pendingSince" TIMESTAMP(3),
    CONSTRAINT "BlurbReference_pkey" PRIMARY KEY ("blurbId", "entityType", "entityId")
);

-- Partial: names are immutable by design, so delete-and-recreate is the only way to fix a
-- typo. Unfiltered, a soft-deleted blurb squats its name and createBlurb reports a conflict
-- for a name absent from the user's list. Matches the cap check, which already filters on
-- deletedAt. NOT expressible as a Prisma @@unique (it carries a WHERE), so schema.full.prisma
-- documents it instead of declaring it.
CREATE UNIQUE INDEX "Blurb_userId_name_key" ON "Blurb"("userId", "name") WHERE "deletedAt" IS NULL;
CREATE INDEX "Blurb_updatedAt_idx" ON "Blurb"("updatedAt");
CREATE INDEX "BlurbReference_entityType_entityId_idx" ON "BlurbReference"("entityType", "entityId");
-- PARTIAL, and ordered by materializedAt rather than pendingSince. The predicate sizes the index
-- to the actual backlog, so a quiet tick is one empty index probe; the ordering column keeps
-- `recordFailure`'s move-to-the-back working, which sorting by pendingSince would have broken.
-- `pendingSince` stays the moment the row went stale, so backlog AGE is still measurable from it.
CREATE INDEX "BlurbReference_pending_idx"
  ON "BlurbReference"("materializedAt") WHERE "pendingSince" IS NOT NULL;

ALTER TABLE "Blurb" ADD CONSTRAINT "Blurb_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BlurbReference" ADD CONSTRAINT "BlurbReference_blurbId_fkey"
  FOREIGN KEY ("blurbId") REFERENCES "Blurb"("id") ON DELETE CASCADE ON UPDATE CASCADE;
