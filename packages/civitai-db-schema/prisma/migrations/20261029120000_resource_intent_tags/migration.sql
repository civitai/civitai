-- ResourceIntentVocabulary and ResourceIntentTagIndexSnapshot — the resource-intent v1
-- content-tag arm's frozen vocabularies and its content-tag index builds.
--
-- Apply this MANUALLY, per environment. We do not use `prisma migrate deploy` anywhere;
-- this file exists for review/history. Re-runnable: every statement is guarded
-- (IF NOT EXISTS, DO blocks, CREATE OR REPLACE, DROP ... IF EXISTS).
--
-- ResourceIntentVocabulary: one row per mined vocabulary. `payload` is the vocabulary
-- document and `vocabVersion` is the sha256 hex of exactly those bytes (a CHECK), so a
-- version names one payload forever. A row is inserted as 'candidate'; it may become
-- 'frozen' (the trigger stamps `frozenAt`; `frozenBy` is required) or 'retired', and a
-- frozen row may become 'retired'. Nothing else about a row can change. The foreign key
-- below accepts a vocabulary in any status; the store refuses a production build of one
-- that is not frozen.
--
-- ResourceIntentTagIndexSnapshot: column-for-column the ResourceIntentCoocSnapshot table
-- and its rules (see 20261011120000_resource_intent_cooc_snapshot), plus the
-- `vocabVersion` the index was built from. A row is inserted when a build starts
-- ('building') with a random id, then set 'ready', 'failed' or 'duplicate' once; only a
-- 'building' row can change. `builtAt` is the database's clock. `contentHash` =
-- sha256(kind || NUL || vocabVersion || NUL || payload) is the snapshot's identity, unique
-- among ready rows. A
-- study row is always pinned, ending after its build and at most 58 days from it; a
-- production row is never pinned.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ResourceIntentVocabulary" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "vocabVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'candidate',
    "payload" BYTEA NOT NULL,
    "rulesSummary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "frozenAt" TIMESTAMP(3),
    "frozenBy" TEXT,

    CONSTRAINT "ResourceIntentVocabulary_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceIntentVocabulary_vocabVersion_key"
    ON "ResourceIntentVocabulary"("vocabVersion");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentVocabulary_version_check'
    ) THEN
        ALTER TABLE "ResourceIntentVocabulary" ADD CONSTRAINT "ResourceIntentVocabulary_version_check"
            CHECK ("vocabVersion" = encode(sha256("payload"), 'hex'));
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentVocabulary_status_check'
    ) THEN
        ALTER TABLE "ResourceIntentVocabulary" ADD CONSTRAINT "ResourceIntentVocabulary_status_check"
            CHECK (
                ("status" = 'candidate' AND "frozenAt" IS NULL AND "frozenBy" IS NULL)
                OR ("status" = 'frozen' AND "frozenAt" IS NOT NULL AND "frozenBy" IS NOT NULL)
                OR ("status" = 'retired' AND ("frozenAt" IS NULL) = ("frozenBy" IS NULL))
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION "ResourceIntentVocabulary_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'candidate' THEN
            RAISE EXCEPTION 'ResourceIntentVocabulary rows are inserted as candidate';
        END IF;
        NEW."createdAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."vocabVersion" IS DISTINCT FROM OLD."vocabVersion"
        OR NEW."payload" IS DISTINCT FROM OLD."payload"
        OR NEW."rulesSummary" IS DISTINCT FROM OLD."rulesSummary"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'ResourceIntentVocabulary %: only status can change', OLD."vocabVersion";
    END IF;
    IF OLD."status" = 'candidate' AND NEW."status" = 'frozen' THEN
        NEW."frozenAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF NEW."frozenAt" IS DISTINCT FROM OLD."frozenAt"
        OR NEW."frozenBy" IS DISTINCT FROM OLD."frozenBy" THEN
        RAISE EXCEPTION 'ResourceIntentVocabulary %: frozenAt and frozenBy are set only by freezing',
            OLD."vocabVersion";
    END IF;
    IF NEW."status" = OLD."status"
        OR (OLD."status" IN ('candidate', 'frozen') AND NEW."status" = 'retired') THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'ResourceIntentVocabulary %: % cannot become %',
        OLD."vocabVersion", OLD."status", NEW."status";
END $$;

DROP TRIGGER IF EXISTS "ResourceIntentVocabulary_guard" ON "ResourceIntentVocabulary";
CREATE TRIGGER "ResourceIntentVocabulary_guard"
    BEFORE INSERT OR UPDATE ON "ResourceIntentVocabulary"
    FOR EACH ROW EXECUTE FUNCTION "ResourceIntentVocabulary_guard"();

CREATE TABLE IF NOT EXISTS "ResourceIntentTagIndexSnapshot" (
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
    "vocabVersion" TEXT NOT NULL,

    CONSTRAINT "ResourceIntentTagIndexSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_kind_status_trainEnd_builtAt_idx"
    ON "ResourceIntentTagIndexSnapshot"("kind", "status", "trainEnd" DESC, "builtAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_contentHash_ready_key"
    ON "ResourceIntentTagIndexSnapshot"("contentHash") WHERE "status" = 'ready';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_vocabVersion_fkey'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_vocabVersion_fkey"
            FOREIGN KEY ("vocabVersion") REFERENCES "ResourceIntentVocabulary"("vocabVersion")
            ON DELETE RESTRICT ON UPDATE RESTRICT;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_kind_pin_check'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_kind_pin_check"
            CHECK (
                ("kind" = 'study' AND "pinnedUntil" IS NOT NULL
                    AND "pinnedUntil" > "builtAt"
                    AND "pinnedUntil" <= "builtAt" + interval '58 days')
                OR ("kind" = 'production' AND "pinnedUntil" IS NULL)
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_ready_check'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_ready_check"
            CHECK (
                "status" <> 'ready' OR (
                    "contentHash" IS NOT NULL AND "payload" IS NOT NULL
                    AND "trainImageIds" IS NOT NULL AND "trainRows" IS NOT NULL
                    AND "trainCreatedAtMin" IS NOT NULL AND "trainCreatedAtMax" IS NOT NULL
                )
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION "ResourceIntentTagIndexSnapshot_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW."builtAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF NEW."builtAt" IS DISTINCT FROM OLD."builtAt" THEN
        RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot.builtAt cannot change';
    END IF;
    IF OLD."status" <> 'building' THEN
        RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot row % is %; only a building row can change',
            OLD."id", OLD."status";
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ResourceIntentTagIndexSnapshot_guard" ON "ResourceIntentTagIndexSnapshot";
CREATE TRIGGER "ResourceIntentTagIndexSnapshot_guard"
    BEFORE INSERT OR UPDATE ON "ResourceIntentTagIndexSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "ResourceIntentTagIndexSnapshot_guard"();
