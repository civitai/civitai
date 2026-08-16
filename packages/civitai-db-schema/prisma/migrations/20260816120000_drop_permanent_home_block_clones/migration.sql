-- Remove user clones of PERMANENT system home blocks.
--
-- A permanent system block is unioned into every homepage. A user who customized
-- their homepage also holds a clone of it, and the union dedupes by row id — which
-- a clone does not share — so both copies render. Measured on prod 2026-08-16:
-- 21,786 clones of block 2 (Announcement) and 4 of block 129095 (CosmeticShop).
--
-- APPLY IN THIS ORDER. Steps 1 and 2 are not optional and step 1 must NOT run
-- inside a transaction.
--
-- The app-side fix stops these rows rendering on its own, so nothing here is
-- urgent — it can trail the deploy by days. Take the time to do it in batches.

-- 1. Index "sourceId" FIRST. Without it this migration takes about an hour and
--    holds locks the whole time, on the table every homepage read hits.
--
--    "HomeBlock" has a self-referencing FK ("HomeBlock_sourceId_fkey", ON DELETE
--    SET NULL) and prod carries only three indexes — pkey, permanent, userId —
--    none on "sourceId". Postgres runs the referential action once per deleted
--    row, so every one of the ~21,588 deletions seq-scans the whole table looking
--    for rows that source off the row being deleted. Measured on the prod replica:
--    one such lookup is a Seq Scan, 130 ms, 34,065 buffers over 408,377 rows.
--    Every one of them matches zero rows, because a clone is never itself a
--    source — the entire cost is referential-integrity overhead.
--
--    CONCURRENTLY so it does not lock out writes. It cannot run inside a
--    transaction block; run it on its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "HomeBlock_sourceId_idx"
  ON "HomeBlock" ("sourceId");

-- 2. VERIFY the index is valid before deleting anything. A cancelled CONCURRENTLY
--    build leaves the index in place marked invalid: the planner ignores it, every
--    write still maintains it, and IF NOT EXISTS makes each retry a silent no-op —
--    so a retry loop can leave you doing the hour-long version believing you fixed it.
--
--    SELECT indisvalid FROM pg_index WHERE indexrelid = '"HomeBlock_sourceId_idx"'::regclass;
--
--    On false: DROP INDEX CONCURRENTLY "HomeBlock_sourceId_idx"; then re-run step 1.

-- 3. Count, and read BOTH columns.
--
--    `index_differs` is the point of the second column: `index` is the user's
--    ordering preference, and it differs from the source on every clone. These rows
--    are NOT redundant copies. Deleting them leaves only the source row, which for
--    block 2 sits at index -1, so Announcements pins to the top of the page for the
--    ~3,785 users who had moved it lower. That is a deliberate, accepted
--    consequence — a permanent block is pinned by definition — but it is a visible
--    change for real users, not a no-op cleanup.
--
--    SELECT src.type,
--           count(*) AS clones,
--           count(*) FILTER (WHERE hb.index IS DISTINCT FROM src.index) AS index_differs,
--           count(*) FILTER (WHERE hb.index <> 0) AS not_at_top
--    FROM "HomeBlock" hb
--    JOIN "HomeBlock" src ON src.id = hb."sourceId"
--    WHERE hb."userId" <> -1 AND src.permanent
--    GROUP BY 1 ORDER BY 2 DESC;

-- 4. Delete in batches, skipping any user this would leave with no rows at all.
--
--    202 users on prod have trimmed their homepage down to nothing but a permanent
--    block, so that clone is their only row. "No rows" and "never customized" are
--    the same state to this app (`userHasCustomHomeBlocks` is a bare EXISTS), so
--    deleting it would not remove one block — it would hand back all 9 system
--    blocks, including every block those users deliberately removed. The NOT EXISTS
--    clause keeps their rows; the app already declines to render them, so it costs
--    nothing but their customized status. They come out with the hidden-marker
--    work, which is what replaces "no rows" as the encoding of "never customized".
--
--    Batched so no single statement holds locks for long. Expect ~21,588 rows,
--    ~5 iterations. Safe to re-run; it stops when a pass deletes nothing.
DO $$
DECLARE
  removed integer;
BEGIN
  LOOP
    DELETE FROM "HomeBlock" hb
    WHERE hb.id IN (
      SELECT c.id
      FROM "HomeBlock" c
      JOIN "HomeBlock" src ON src.id = c."sourceId"
      WHERE c."userId" <> -1
        AND src.permanent
        AND EXISTS (
          SELECT 1
          FROM "HomeBlock" keep
          WHERE keep."userId" = c."userId"
            AND NOT EXISTS (
              SELECT 1 FROM "HomeBlock" ks WHERE ks.id = keep."sourceId" AND ks.permanent
            )
        )
      LIMIT 5000
    );
    GET DIAGNOSTICS removed = ROW_COUNT;
    RAISE NOTICE 'deleted % rows', removed;
    EXIT WHEN removed = 0;
    COMMIT;
  END LOOP;
END $$;

-- 5. VERIFY. The count query in step 3 should now report only the retained rows —
--    expect ~202, one per user whose homepage would otherwise have reset to the
--    default. Zero is WRONG and means the NOT EXISTS clause did not apply.
