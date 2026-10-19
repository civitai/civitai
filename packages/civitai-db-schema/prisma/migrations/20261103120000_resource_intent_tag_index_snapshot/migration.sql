-- ResourceIntentTagIndexSnapshot — manifest rows for stored resource-intent v1 tag-index snapshots.
--
-- Apply this MANUALLY, per environment, AFTER 20261029120000_resource_intent_tags (the foreign key
-- references "ResourceIntentVocabulary", and the second trigger below is on that table) and before
-- anything calls putSnapshot. We do not use `prisma migrate deploy` anywhere; this file exists for
-- review/history. Re-runnable: every statement is guarded (IF NOT EXISTS, DO blocks, CREATE OR
-- REPLACE, DROP ... IF EXISTS).
--
-- The payload itself (msgpack + brotli, tens of MiB) lives in object storage under a
-- content-addressed key ending '/<payloadSha256>'; this row is its manifest. The writer uploads first
-- and inserts the row second, so a row is born 'ready' and there is no 'building' state: a build that
-- dies before the insert leaves an unreferenced object and no row. 'retired' withdraws a row from
-- serving and is one-way, so a retention job may delete a retired row's object once no ready row
-- names the same key. `createdAt` is the database's clock (the guard overwrites any value a writer
-- supplies).
--
-- Every row's vocabulary must be frozen when the row is inserted. The guard reads the vocabulary
-- row FOR SHARE, so an un-freeze running concurrently waits for the insert to finish (or the insert
-- waits for it, then sees the new status); and the vocabulary trigger refuses moving a vocabulary
-- back to 'candidate' while a ready snapshot names it.
--
-- Privileges: FOR SHARE needs UPDATE on at least one column of the locked table, so a snapshot
-- writer that does not own "ResourceIntentVocabulary" also needs
--   GRANT UPDATE ("vocabVersion") ON "ResourceIntentVocabulary" TO <writer>;
-- besides SELECT on it and SELECT, INSERT on this table (and UPDATE here to retire rows). Without it
-- every insert fails with "permission denied for table ResourceIntentVocabulary", after the upload.
-- That column grant can change nothing: a new "vocabVersion" fails the table's sha256 CHECK (and the
-- foreign key while a snapshot names it), so only a no-op update is possible. The table owner
-- needs no grant.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ResourceIntentTagIndexSnapshot" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "vocabVersion" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "buildStats" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ResourceIntentTagIndexSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResourceIntentTagIndexSnapshot_vocabVersion_fkey" FOREIGN KEY ("vocabVersion")
        REFERENCES "ResourceIntentVocabulary"("vocabVersion") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_latest_ready_idx"
    ON "ResourceIntentTagIndexSnapshot"("specHash", "status", "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_payloadSha256_ready_key"
    ON "ResourceIntentTagIndexSnapshot"("payloadSha256") WHERE "status" = 'ready';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_status_check'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_status_check"
            CHECK (
                ("status" = 'ready' AND "retiredAt" IS NULL)
                OR ("status" = 'retired' AND "retiredAt" IS NOT NULL)
            );
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_payload_check'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_payload_check"
            CHECK (
                "payloadSha256" ~ '^[0-9a-f]{64}$'
                AND "specHash" ~ '^[0-9a-f]{64}$'
                AND "payloadBytes" > 0 AND "payloadBytes" <= 134217728
                AND "objectKey" LIKE '_%/' || "payloadSha256"
                AND jsonb_typeof("buildStats") = 'object'
            );
    END IF;
END $$;

CREATE OR REPLACE FUNCTION "ResourceIntentTagIndexSnapshot_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'ready' THEN
            RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot rows are inserted ready';
        END IF;
        PERFORM 1 FROM "ResourceIntentVocabulary"
            WHERE "vocabVersion" = NEW."vocabVersion" AND "status" = 'frozen'
            FOR SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'a ResourceIntentTagIndexSnapshot needs a frozen vocabulary; % is not',
                NEW."vocabVersion";
        END IF;
        NEW."createdAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF (NEW."id", NEW."vocabVersion", NEW."specHash", NEW."payloadSha256",
        NEW."payloadBytes", NEW."objectKey", NEW."buildStats", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."vocabVersion", OLD."specHash", OLD."payloadSha256",
        OLD."payloadBytes", OLD."objectKey", OLD."buildStats", OLD."createdAt")
    THEN
        RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot row % : only its status can change', OLD."id";
    END IF;
    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF NOT (OLD."status" = 'ready' AND NEW."status" = 'retired') THEN
            RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot row % : % -> % is not allowed (retire is one-way)',
                OLD."id", OLD."status", NEW."status";
        END IF;
        NEW."retiredAt" := CURRENT_TIMESTAMP;
    ELSIF NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" THEN
        RAISE EXCEPTION 'ResourceIntentTagIndexSnapshot.retiredAt cannot change';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ResourceIntentTagIndexSnapshot_guard" ON "ResourceIntentTagIndexSnapshot";
CREATE TRIGGER "ResourceIntentTagIndexSnapshot_guard"
    BEFORE INSERT OR UPDATE ON "ResourceIntentTagIndexSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "ResourceIntentTagIndexSnapshot_guard"();

-- A vocabulary a ready snapshot names may be retired (its successor is frozen) but not moved back to
-- 'candidate': nothing serves a snapshot built on a candidate. Retire the snapshot first.
CREATE OR REPLACE FUNCTION "ResourceIntentVocabulary_snapshot_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" = 'candidate' AND OLD."status" <> 'candidate' AND EXISTS (
        SELECT 1 FROM "ResourceIntentTagIndexSnapshot"
        WHERE "vocabVersion" = OLD."vocabVersion" AND "status" = 'ready'
    ) THEN
        RAISE EXCEPTION 'vocabulary % has a ready ResourceIntentTagIndexSnapshot; retire the snapshot first',
            OLD."vocabVersion";
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "ResourceIntentVocabulary_snapshot_guard" ON "ResourceIntentVocabulary";
CREATE TRIGGER "ResourceIntentVocabulary_snapshot_guard"
    BEFORE UPDATE OF "status" ON "ResourceIntentVocabulary"
    FOR EACH ROW EXECUTE FUNCTION "ResourceIntentVocabulary_snapshot_guard"();
