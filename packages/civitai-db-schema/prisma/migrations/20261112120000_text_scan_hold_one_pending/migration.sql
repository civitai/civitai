-- One pending csam hold per entity. A rescan of edited text now updates the pending hold in place
-- instead of queueing another one per distinct text hash (ChatMessage keeps its own per-window grouping).
--
-- HAND-APPLIED. Apply before deploying the application change that relies on the partial unique index:
-- without it, two concurrent detections could leave two pending holds for one entity.

-- 1. Collapse existing duplicates to one pending hold per entity, and close the rest. They are marked as
--    superseded rather than dismissed by a person, so the queue never reads them as a ruling.
--    The survivor is the hold a moderator is mid-decision on (live claim, same 30 minutes the application
--    honours), else the one holding the entity's last scanned text, else the newest. Run while nobody is
--    deciding: a superseded hold with a claim makes that decision fail as already decided.
--    Only entities with duplicates read EntityModeration, by exact key, so the table is never sorted whole.
WITH dup AS (
  SELECT DISTINCT "entityType", "entityId"
  FROM "TextScanHold"
  WHERE "status" = 'Pending' AND "entityType" <> 'ChatMessage'
  GROUP BY "entityType", "entityId", "label"
  HAVING count(*) > 1
),
latest AS (
  SELECT DISTINCT ON (d."entityType", d."entityId")
         d."entityType", d."entityId", em."result"->>'textHash' AS "textHash"
  FROM dup d
  JOIN "EntityModeration" em
    ON em."entityId" = d."entityId" AND em."entityType" IN (d."entityType", d."entityType" || ':shadow')
  WHERE em."result"->>'textHash' IS NOT NULL
  ORDER BY d."entityType", d."entityId", em."updatedAt" DESC, em."id" DESC
),
ranked AS (
  SELECT h."id",
         first_value(h."id") OVER w AS "keptId",
         row_number() OVER w AS "rank"
  FROM "TextScanHold" h
  LEFT JOIN latest l ON l."entityType" = h."entityType" AND l."entityId" = h."entityId"
  WHERE h."status" = 'Pending' AND h."entityType" <> 'ChatMessage'
  WINDOW w AS (
    PARTITION BY h."entityType", h."entityId", h."label"
    ORDER BY coalesce((h."meta"->'decisionClaim'->>'at')::timestamptz >= now() - interval '30 minutes', false) DESC,
             coalesce(h."textHash" = l."textHash", false) DESC,
             h."id" DESC
  )
)
UPDATE "TextScanHold" AS h
SET "status" = 'Dismissed',
    "decidedAt" = now(),
    "updatedAt" = now(),
    "decisionNote" = 'superseded by a newer scan of the same content',
    "meta" = ((CASE WHEN jsonb_typeof(h."meta") = 'object' THEN h."meta" ELSE '{}'::jsonb END) - 'decisionClaim')
      || jsonb_build_object('decision', 'superseded', 'superseded', true, 'supersededBy', r."keptId")
FROM ranked r
WHERE h."id" = r."id" AND r."rank" > 1;

-- 1b. A pending hold with a ruling before it on the same entity is a re-detection, as the application marks
--     one: kind 'redetected' and priorHoldId = the latest ruling before it. Superseded holds were never ruled on.
--     Holds that already carry a priorHoldId are left alone, so a re-run changes nothing.
WITH marks AS (
  SELECT p."id",
         (SELECT x."id"
          FROM "TextScanHold" x
          WHERE x."entityType" = p."entityType" AND x."entityId" = p."entityId" AND x."label" = p."label"
            AND x."status" <> 'Pending' AND x."id" < p."id"
            AND x."meta"->>'decision' IS DISTINCT FROM 'superseded'
          ORDER BY x."id" DESC
          LIMIT 1) AS "priorHoldId"
  FROM "TextScanHold" p
  WHERE p."status" = 'Pending' AND p."label" = 'csam' AND p."entityType" <> 'ChatMessage'
    AND NOT coalesce(p."meta" ? 'priorHoldId', false)
)
UPDATE "TextScanHold" AS p
SET "meta" = (CASE WHEN jsonb_typeof(p."meta") = 'object' THEN p."meta" ELSE '{}'::jsonb END)
      || jsonb_build_object('kind', 'redetected', 'priorHoldId', m."priorHoldId"),
    "updatedAt" = now()
FROM marks m
WHERE p."id" = m."id" AND m."priorHoldId" IS NOT NULL;

-- 2. The text hash is no longer unique per entity: a later scan of the same text after a decision is
--    skipped by the application, and changed text is a new hold or an in-place update.
DROP INDEX IF EXISTS "TextScanHold_entityType_entityId_label_textHash_key";
CREATE INDEX IF NOT EXISTS "TextScanHold_entityType_entityId_label_textHash_idx"
  ON "TextScanHold" ("entityType", "entityId", "label", "textHash");

-- 3. A redelivered scan of a chat message must not insert twice.
CREATE UNIQUE INDEX IF NOT EXISTS "TextScanHold_chat_textHash_key"
  ON "TextScanHold" ("entityType", "entityId", "label", "textHash")
  WHERE "entityType" = 'ChatMessage';

-- 4. At most one pending hold per entity.
CREATE UNIQUE INDEX IF NOT EXISTS "TextScanHold_one_pending_per_entity_key"
  ON "TextScanHold" ("entityType", "entityId", "label")
  WHERE "status" = 'Pending' AND "entityType" <> 'ChatMessage';

CREATE INDEX IF NOT EXISTS "TextScanHold_userId_createdAt_idx"
  ON "TextScanHold" ("userId", "createdAt" DESC);
