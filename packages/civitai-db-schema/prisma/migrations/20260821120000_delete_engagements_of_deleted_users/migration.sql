-- Backfill for the `deleteUser` predicate fix (868kurkcf).
--
-- `deleteUser` meant to clear a deleted account's UserEngagement rows but its
-- predicate was `OR: [{ userId, targetUserId }]` — one OR element carrying two
-- fields, i.e. `userId = X AND targetUserId = X`, which matches only a
-- self-engagement row. `deleteUser` soft-deletes the User row, so no FK cascade
-- covered for it: every follow, hide and block belonging to or aimed at a deleted
-- account is still there, and `getUserList` still counts them. That is the
-- "deleted people in my followers list" complaint.
--
-- APPLY BY HAND, off-peak. This repo does not run `prisma migrate deploy`.
--
-- `UserEngagement` is ~42M rows / ~9.6GB in prod. Its indexes are the PK
-- (userId, targetUserId) and (type, userId) — there is NO index on targetUserId
-- alone, so the second half below costs one sequential scan. The work list is
-- materialised by primary key (not ctid, which VACUUM can hand to a different
-- row) and drained in batches so no single statement holds a 42M-row transaction.

-- Half 1: engagements BY deleted users. PK-prefix driven, cheap.
DO $$
DECLARE
  removed integer;
BEGIN
  LOOP
    DELETE FROM "UserEngagement" ue
    WHERE (ue."userId", ue."targetUserId") IN (
      SELECT e."userId", e."targetUserId"
      FROM "UserEngagement" e
      JOIN "User" u ON u.id = e."userId"
      WHERE u."deletedAt" IS NOT NULL
      LIMIT 10000
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    RAISE NOTICE 'by-deleted-user batch: % rows', removed;
    EXIT WHEN removed = 0;
    COMMIT;
  END LOOP;
END $$;

-- Half 2: engagements AIMED AT deleted users. One scan to build the list, then
-- batched PK deletes off it.
CREATE TEMP TABLE doomed_engagement AS
SELECT e."userId", e."targetUserId"
FROM "UserEngagement" e
JOIN "User" u ON u.id = e."targetUserId"
WHERE u."deletedAt" IS NOT NULL;

CREATE INDEX ON doomed_engagement ("userId", "targetUserId");

DO $$
DECLARE
  picked integer;
BEGIN
  LOOP
    -- `picked` counts the WORK LIST batch, not the UserEngagement delete: half 1
    -- may already have removed some of these rows, and exiting on that count would
    -- stop the loop with the list still full.
    WITH batch AS (
      DELETE FROM doomed_engagement d
      WHERE (d."userId", d."targetUserId") IN (
        SELECT "userId", "targetUserId" FROM doomed_engagement LIMIT 10000
      )
      RETURNING d."userId", d."targetUserId"
    ), gone AS (
      DELETE FROM "UserEngagement" ue
      USING batch b
      WHERE ue."userId" = b."userId" AND ue."targetUserId" = b."targetUserId"
      RETURNING 1
    )
    SELECT count(*) INTO picked FROM batch;
    RAISE NOTICE 'at-deleted-user batch: % rows', picked;
    EXIT WHEN picked = 0;
    COMMIT;
  END LOOP;
END $$;

DROP TABLE IF EXISTS doomed_engagement;
