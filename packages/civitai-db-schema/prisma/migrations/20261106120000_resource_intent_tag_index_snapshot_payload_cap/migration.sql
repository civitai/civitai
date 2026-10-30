-- ResourceIntentTagIndexSnapshot: raise the payload size bound from 128 MiB to 256 MiB.
--
-- Apply this MANUALLY, per environment, AFTER 20261103120000_resource_intent_tag_index_snapshot and
-- BEFORE turning on resource-intent-tag-index-build with this code: until then every production
-- build refuses before reading anything (it checks this CHECK's bound). We do not use
-- `prisma migrate deploy` anywhere; this file exists for review/history.
--
-- The tag-index build now indexes every eligible model, whose payload exceeds the old bound
-- (docs/resource-intent-primitive.md, Snapshot). The new bound is the code's
-- TAG_INDEX_MAX_PAYLOAD_BYTES (resource-intent-tags/payload-decode.ts); the two must stay equal.
-- Every other condition of the CHECK is unchanged.
--
-- Re-runnable: the constraint is dropped if present and re-added, in one DO block, so the table is
-- never left without it. Every existing row satisfies the new CHECK (the old bound is lower), so
-- validating it cannot fail.

SET lock_timeout = '3s';

DO $$
BEGIN
    ALTER TABLE "ResourceIntentTagIndexSnapshot"
        DROP CONSTRAINT IF EXISTS "ResourceIntentTagIndexSnapshot_payload_check";
    ALTER TABLE "ResourceIntentTagIndexSnapshot" ADD CONSTRAINT "ResourceIntentTagIndexSnapshot_payload_check"
        CHECK (
            "payloadSha256" ~ '^[0-9a-f]{64}$'
            AND "specHash" ~ '^[0-9a-f]{64}$'
            AND "payloadBytes" > 0 AND "payloadBytes" <= 268435456
            AND "objectKey" LIKE '_%/' || "payloadSha256"
            AND jsonb_typeof("buildStats") = 'object'
        );
END $$;
