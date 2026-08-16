-- Empty the metadata column on linked clones. They are pointers now.
--
-- A clone resolves its content AND its presentation from the system block it points at, so its
-- own metadata column is read by nothing after the accompanying deploy. What it holds today is
-- either an identical copy or a stale one. Measured on prod 2026-08-16, of 264,491 linked clones:
--
--   Leaderboard          61,248 of 62,271 stale
--   FeaturedCollections  10,965 of 11,188 stale
--   Collection              494 of 113,891 stale
--   Feed / FeaturedModelVersion / Announcement   0 stale
--
-- The Collection 494 are the reason this matters rather than being housekeeping: their
-- description still reads "Ran out of Buzz while play?" because the typo was fixed on the system
-- block through the Retool path, which never propagated. Those users have been reading the typo
-- ever since.
--
-- APPLY AFTER THE DEPLOY. Before it, Collection blocks still render from this column, so emptying
-- it first would blank 113,891 users' Featured Images and Buzz Beggars blocks. Nothing breaks if
-- it is never applied — the column is simply ignored — so there is no hurry, only an order.

-- 1. Count first.
--
--    SELECT src.type, count(*) AS clones,
--           count(*) FILTER (WHERE hb.metadata::text <> '{}') AS carrying_metadata
--    FROM "HomeBlock" hb
--    JOIN "HomeBlock" src ON src.id = hb."sourceId"
--    WHERE hb."userId" <> -1
--    GROUP BY 1 ORDER BY 2 DESC;

-- 2. Empty in batches. `metadata` is NOT NULL with a '{}' default, so this writes '{}', not NULL.
--    Uses "HomeBlock_sourceId_idx" from the preceding migration — without that index the
--    subquery seq-scans 408k rows on every pass.
DO $$
DECLARE
  touched integer;
BEGIN
  LOOP
    UPDATE "HomeBlock" hb
    SET metadata = '{}'::jsonb
    WHERE hb.id IN (
      SELECT c.id
      FROM "HomeBlock" c
      JOIN "HomeBlock" src ON src.id = c."sourceId"
      WHERE c."userId" <> -1
        AND c.metadata::text <> '{}'
      LIMIT 5000
    );
    GET DIAGNOSTICS touched = ROW_COUNT;
    RAISE NOTICE 'emptied % rows', touched;
    EXIT WHEN touched = 0;
    COMMIT;
  END LOOP;
END $$;

-- 3. VERIFY — `carrying_metadata` in step 1 must now be 0 for every type.
--
--    And spot-check that a customized user still sees the right thing, since this is the step
--    that makes read-through load-bearing rather than merely correct:
--
--    SELECT hb.id, hb."userId", src.metadata->>'title'
--    FROM "HomeBlock" hb JOIN "HomeBlock" src ON src.id = hb."sourceId"
--    WHERE hb."sourceId" = 3 LIMIT 5;
