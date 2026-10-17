-- ResourceIntentTagIndexSnapshot — manifest rows for stored resource-intent v1 tag-index snapshots.
--
-- Apply this MANUALLY, per environment, AFTER 20261029120000_resource_intent_tags (the foreign key
-- references "ResourceIntentVocabulary") and before anything calls putSnapshot. We do not use
-- `prisma migrate deploy` anywhere; this file exists for review/history. Re-runnable: every
-- statement is guarded (IF NOT EXISTS, DO blocks, CREATE OR REPLACE, DROP ... IF EXISTS).
--
-- The payload itself (msgpack + brotli, tens of MiB) lives in object storage under a
-- content-addressed key ending '/<kind>/<payloadSha256>'; this row is its manifest. The writer
-- uploads first and inserts the row second, so a row is born 'ready' and there is no 'building'
-- state: a build that dies before the insert leaves an unreferenced object and no row. 'retired'
-- withdraws a row from serving and is one-way, so a retention job may delete a retired row's object
-- once no ready row names the same key. `createdAt` is the database's clock (the trigger overwrites
-- any value a writer supplies), because the study pin CHECK measures from it. The trigger also
-- refuses a production row whose vocabulary is not frozen at insert time.

SET lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "ResourceIntentTagIndexSnapshot" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "vocabVersion" TEXT NOT NULL,
    "specHash" TEXT NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "payloadBytes" INTEGER NOT NULL,
    "objectKey" TEXT NOT NULL,
    "pinnedUntil" TIMESTAMP(3),
    "buildStats" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "ResourceIntentTagIndexSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ResourceIntentTagIndexSnapshot_vocabVersion_fkey" FOREIGN KEY ("vocabVersion")
        REFERENCES "ResourceIntentVocabulary"("vocabVersion") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_latest_ready_idx"
    ON "ResourceIntentTagIndexSnapshot"("kind", "specHash", "status", "createdAt" DESC);

CREATE UNIQUE INDEX IF NOT EXISTS "ResourceIntentTagIndexSnapshot_kind_payloadSha256_ready_key"
    ON "ResourceIntentTagIndexSnapshot"("kind", "payloadSha256") WHERE "status" = 'ready';

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
        SELECT 1 FROM pg_constraint WHERE conname = 'ResourceIntentTagIndexSnapshot_kind_pin_check'
    ) THEN
        ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_kind_pin_check"
            CHECK (
                ("kind" = 'study' AND "pinnedUntil" IS NOT NULL
                    AND "pinnedUntil" > "createdAt"
                    AND "pinnedUntil" <= "createdAt" + interval '58 days')
                OR ("kind" = 'production' AND "pinnedUntil" IS NULL)
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
                AND "objectKey" LIKE '_%/' || "kind" || '/' || "payloadSha256"
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
        IF NEW."kind" = 'production' AND NOT EXISTS (
            SELECT 1 FROM "ResourceIntentVocabulary"
            WHERE "vocabVersion" = NEW."vocabVersion" AND "status" = 'frozen'
        ) THEN
            RAISE EXCEPTION 'a production ResourceIntentTagIndexSnapshot needs a frozen vocabulary; % is not',
                NEW."vocabVersion";
        END IF;
        NEW."createdAt" := CURRENT_TIMESTAMP;
        RETURN NEW;
    END IF;
    IF (NEW."id", NEW."kind", NEW."vocabVersion", NEW."specHash", NEW."payloadSha256",
        NEW."payloadBytes", NEW."objectKey", NEW."pinnedUntil", NEW."buildStats", NEW."createdAt")
       IS DISTINCT FROM
       (OLD."id", OLD."kind", OLD."vocabVersion", OLD."specHash", OLD."payloadSha256",
        OLD."payloadBytes", OLD."objectKey", OLD."pinnedUntil", OLD."buildStats", OLD."createdAt")
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
