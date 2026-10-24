-- ResourceIntentVocabulary — the resource-intent v1 content-tag arm's mined vocabularies.
--
-- Apply this MANUALLY, per environment. We do not use `prisma migrate deploy` anywhere;
-- this file exists for review/history. Re-runnable: every statement is guarded
-- (IF NOT EXISTS, DO blocks).
--
-- One row per mined vocabulary. `payload` is the vocabulary document and `vocabVersion` is
-- the sha256 hex of exactly those bytes (a CHECK), so a version names one payload forever.
-- `status` is 'candidate' (the default), 'frozen' (with `frozenAt` and `frozenBy` both set)
-- or 'retired' (with both set or both null); a CHECK holds those combinations. Nothing in the database enforces the order
-- of status changes. The tag-index snapshot table that will reference a vocabulary, and the
-- rule that a production build needs a frozen one, arrive with design phase P6.

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
