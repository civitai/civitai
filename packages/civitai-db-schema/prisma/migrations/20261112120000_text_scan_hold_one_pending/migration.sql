-- One pending csam hold per entity. A rescan of edited text now updates the pending hold in place
-- instead of queueing another one per distinct text hash (ChatMessage keeps its own per-window grouping).
--
-- HAND-APPLIED. Apply before deploying the application change that relies on the partial unique index:
-- the new upsert names that index as its conflict target and fails without it.

-- 1. Collapse existing duplicates: keep the newest pending hold per entity, close the rest. They are
--    marked as superseded rather than dismissed by a person, so the queue never reads them as a ruling.
WITH ranked AS (
  SELECT "id",
         first_value("id") OVER w AS "keptId",
         row_number() OVER w AS "rank"
  FROM "TextScanHold"
  WHERE "status" = 'Pending' AND "entityType" <> 'ChatMessage'
  WINDOW w AS (PARTITION BY "entityType", "entityId", "label" ORDER BY "id" DESC)
)
UPDATE "TextScanHold" AS h
SET "status" = 'Dismissed',
    "decidedAt" = now(),
    "updatedAt" = now(),
    "decisionNote" = 'superseded by a newer scan of the same content',
    "meta" = (CASE WHEN jsonb_typeof(h."meta") = 'object' THEN h."meta" ELSE '{}'::jsonb END)
      || jsonb_build_object('decision', 'superseded', 'superseded', true, 'supersededBy', r."keptId")
FROM ranked r
WHERE h."id" = r."id" AND r."rank" > 1;

-- 2. The text hash is no longer unique per entity: a later scan of the same text after a decision is
--    skipped by the application, and changed text is a new hold or an in-place update.
DROP INDEX IF EXISTS "TextScanHold_entityType_entityId_label_textHash_key";
CREATE INDEX IF NOT EXISTS "TextScanHold_entityType_entityId_label_textHash_idx"
  ON "TextScanHold" ("entityType", "entityId", "label", "textHash");

-- 3. Chat holds group by conversation window and still dedupe a redelivered scan by text hash.
CREATE UNIQUE INDEX IF NOT EXISTS "TextScanHold_chat_textHash_key"
  ON "TextScanHold" ("entityType", "entityId", "label", "textHash")
  WHERE "entityType" = 'ChatMessage';

-- 4. At most one pending hold per entity; the upsert's conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS "TextScanHold_one_pending_per_entity_key"
  ON "TextScanHold" ("entityType", "entityId", "label")
  WHERE "status" = 'Pending' AND "entityType" <> 'ChatMessage';

-- 5. The author's other holds, for the moderator queue's author context and "same author" grouping.
CREATE INDEX IF NOT EXISTS "TextScanHold_userId_createdAt_idx"
  ON "TextScanHold" ("userId", "createdAt" DESC);
