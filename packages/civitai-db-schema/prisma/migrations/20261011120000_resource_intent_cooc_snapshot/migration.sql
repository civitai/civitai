-- ResourceIntentCoocSnapshot — builds of the resource-intent co-occurrence index.
--
-- Apply this MANUALLY, per environment, BEFORE turning on the
-- `resource-intent-cooc-build` flag or running scripts/build-resource-intent-cooc.ts
-- without --dry-run. We do not use `prisma migrate deploy` anywhere; this file exists
-- for review/history. Re-runnable: every statement is guarded with IF NOT EXISTS / DO blocks.
--
-- A row is inserted when a build starts ('building') with a random id, then set
-- 'ready' or 'failed' once; a ready row is never updated again, only deleted by
-- retention. `builtAt` is the database's clock, never the writer's.
--
-- `contentHash` = sha256(kind || NUL || payload), where `payload` is msgpack + brotli
-- of integer counts. It is the snapshot's identity: unique among ready rows (partial
-- index below), verified on every load, and what a study pins. A study and a production
-- build of identical data therefore have distinct hashes.
--
-- `kind` and `status` are TEXT rather than enums. The CHECKs hold the rules the app also
-- enforces: a study row is always pinned, for at most 58 days from its build (with a daily
-- sweep and a ~26 h heartbeat staleness alert, a missed sweep alerts before any study row
-- reaches 60 days); a production row is never pinned;
-- a ready row carries its hash, payload and counts.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ResourceIntentCoocSnapshot" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'building',
    "contentHash" TEXT,
    "specHash" TEXT NOT NULL,
    "trainStart" TIMESTAMP(3) NOT NULL,
    "trainEnd" TIMESTAMP(3) NOT NULL,
    "seed" INTEGER NOT NULL,
    "pinnedUntil" TIMESTAMP(3),
    "builtAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "trainCreatedAtMin" TIMESTAMP(3),
    "trainCreatedAtMax" TIMESTAMP(3),
    "idsTried" INTEGER,
    "trainRows" INTEGER,
    "vocab" INTEGER,
    "models" INTEGER,
    "keptPairs" INTEGER,
    "payload" BYTEA,
    "trainImageIds" BYTEA,

    CONSTRAINT "ResourceIntentCoocSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ResourceIntentCoocSnapshot_kind_status_trainEnd_builtAt_idx"
    ON "ResourceIntentCoocSnapshot"("kind", "status", "trainEnd" DESC, "builtAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceIntentCoocSnapshot_contentHash_ready_key"
    ON "ResourceIntentCoocSnapshot"("contentHash") WHERE "status" = 'ready';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentCoocSnapshot_kind_pin_check'
    ) THEN
        ALTER TABLE "ResourceIntentCoocSnapshot" ADD CONSTRAINT "ResourceIntentCoocSnapshot_kind_pin_check"
            CHECK (
                ("kind" = 'study' AND "pinnedUntil" IS NOT NULL
                    AND "pinnedUntil" <= "builtAt" + interval '58 days')
                OR ("kind" = 'production' AND "pinnedUntil" IS NULL)
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentCoocSnapshot_ready_check'
    ) THEN
        ALTER TABLE "ResourceIntentCoocSnapshot" ADD CONSTRAINT "ResourceIntentCoocSnapshot_ready_check"
            CHECK (
                "status" <> 'ready' OR (
                    "contentHash" IS NOT NULL AND "payload" IS NOT NULL
                    AND "trainImageIds" IS NOT NULL AND "trainRows" IS NOT NULL
                    AND "trainCreatedAtMin" IS NOT NULL AND "trainCreatedAtMax" IS NOT NULL
                )
            );
    END IF;
END $$;
