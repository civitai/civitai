-- ResourceIntentCoocSnapshot — builds of the resource-intent co-occurrence index.
--
-- Apply this MANUALLY, per environment, BEFORE turning on the
-- `resource-intent-cooc-build` flag or running scripts/build-resource-intent-cooc.ts
-- without --dry-run. We do not use `prisma migrate deploy` anywhere; this file exists
-- for review/history. Re-runnable: every statement is guarded (IF NOT EXISTS, DO blocks,
-- CREATE OR REPLACE, DROP ... IF EXISTS).
--
-- A row is inserted when a build starts ('building') with a random id, then set
-- 'ready', 'failed' or 'duplicate' once; only a 'building' row can change, and rows are
-- removed only by delete (retention or an explicit study release). `builtAt` is the
-- database's clock: the trigger below overwrites any value a writer supplies and
-- refuses to change it.
--
-- `contentHash` = sha256(kind || NUL || payload), where `payload` is msgpack + brotli
-- of integer counts and the vocabulary of tokens that have a kept (token, model) pair.
-- It is the snapshot's identity: unique among ready rows (partial
-- index below), verified on every load, and what a study pins. A study and a production
-- build of identical data therefore have distinct hashes.
--
-- `kind` and `status` are TEXT rather than enums. The CHECKs hold the rules the app also
-- enforces: a study row is always pinned, ending after its build and at most 58 days
-- from it (with the daily retention sweep and a ~26 h staleness alert on its heartbeat,
-- which must be provisioned outside this repo, a missed sweep alerts before any study
-- row reaches 60 days); a production row is never pinned; a ready row carries its hash,
-- payload, training ids, row count and created-at bounds.

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
                    AND "pinnedUntil" > "builtAt"
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

-- The guard is what makes `builtAt` trustworthy: the 58-day pin CHECK and the 4-week
-- production rotation both measure from it, so a manual edit must not be able to move it
-- or rewrite a finished row.
CREATE OR REPLACE FUNCTION "ResourceIntentCoocSnapshot_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."builtAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF NEW."builtAt" IS DISTINCT FROM OLD."builtAt" THEN
        RAISE EXCEPTION 'ResourceIntentCoocSnapshot.builtAt cannot change';
    END IF;
    IF OLD."status" <> 'building' THEN
        RAISE EXCEPTION 'ResourceIntentCoocSnapshot row % is %; only a building row can change',
            OLD."id", OLD."status";
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ResourceIntentCoocSnapshot_guard" ON "ResourceIntentCoocSnapshot";
CREATE TRIGGER "ResourceIntentCoocSnapshot_guard"
    BEFORE INSERT OR UPDATE ON "ResourceIntentCoocSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "ResourceIntentCoocSnapshot_guard"();
