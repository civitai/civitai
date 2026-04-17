-- ============================================================================
-- Collection nsfwLevel rollup — query ideas for review
-- ============================================================================
-- Goal: compute Collection.nsfwLevel = bit_or of all ACCEPTED items' nsfwLevel
-- across 4 item types (Image, Post, Model, Article), fast enough to run in ms
-- per collection so the backlog drains and propagation stays current.
--
-- Current production query (nsfwLevels.service.ts:380-429) has two problems:
--   1. 4-way LEFT JOIN (Image + Post + Model + Article) per collection row
--   2. Subquery `LIMIT 50` → misses NSFW items beyond the newest 50
--      (confirmed bug: big collections misrated silently)
--
-- Indexes available on CollectionItem:
--   hash: collectionId, imageId, modelId, addedById
--   unique btree: (collectionId, articleId, postId, imageId, modelId)
--   NONE on: status, postId (solo), articleId (solo), (collectionId, status)
--
-- Likely need a new partial btree before any of these queries perform well:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS
--     "CollectionItem_collectionId_status_accepted_idx"
--     ON "CollectionItem"("collectionId")
--     WHERE status = 'ACCEPTED';
-- ============================================================================


-- ----------------------------------------------------------------------------
-- BASELINE — current prod query, for EXPLAIN ANALYZE comparison
-- ----------------------------------------------------------------------------
WITH collections AS (
  SELECT
    c.id,
    (
      CASE
        WHEN (c."nsfw" IS TRUE) THEN 28 -- nsfwBrowsingLevelsFlag
        ELSE COALESCE((
          SELECT bit_or(COALESCE(item_nsfw."nsfwLevel", 0))
          FROM (
            SELECT
              ci."collectionId",
              COALESCE(
                CASE WHEN ci."imageId" IS NOT NULL THEN i."nsfwLevel" END,
                CASE WHEN ci."postId"  IS NOT NULL THEN p."nsfwLevel" END,
                CASE WHEN ci."modelId" IS NOT NULL THEN m."nsfwLevel" END,
                CASE WHEN ci."articleId" IS NOT NULL THEN a."nsfwLevel" END,
                0
              ) AS "nsfwLevel"
            FROM "CollectionItem" ci
            LEFT JOIN "Image"   i ON ci."imageId"   = i.id
            LEFT JOIN "Post"    p ON ci."postId"    = p.id AND p."publishedAt" IS NOT NULL
            LEFT JOIN "Model"   m ON ci."modelId"   = m.id AND m."status" = 'Published'
            LEFT JOIN "Article" a ON ci."articleId" = a.id AND a."publishedAt" IS NOT NULL
            WHERE ci."collectionId" = c.id AND ci."status" = 'ACCEPTED'
            ORDER BY ci."createdAt" DESC
            LIMIT 50                      -- ← BUG: misses items beyond newest 50
          ) AS item_nsfw
          GROUP BY item_nsfw."collectionId"
        ), 0)
      END
    ) AS "nsfwLevel"
  FROM "Collection" c
  WHERE c.id IN ($1) AND c."availability" = 'Public'
)
UPDATE "Collection" c
SET "nsfwLevel" = c2."nsfwLevel"
FROM collections c2
WHERE c.id = c2.id AND c."nsfwLevel" != c2."nsfwLevel"
RETURNING c.id;


-- ----------------------------------------------------------------------------
-- IDEA 1 — Per-type bit_or CTEs, UNION, aggregate
-- ----------------------------------------------------------------------------
-- Each item type gets its own simple join (one FK per CTE instead of four
-- LEFT JOINs per row). bit_or is commutative/associative → UNION the
-- per-type bitmaps then bit_or once at the top. No LIMIT, all items counted.
--
-- Expected: linear in total ACCEPTED items. Two index hops per type
-- (CollectionItem by collectionId → target table by PK).
-- Batches well — drop the `$1` in favour of `IN (...)` over the whole batch
-- so each CTE scans once for the full batch instead of per-collection.
--
-- Correctness note: Post/Model/Article use publishedAt / status filters just
-- like today. Image has no such filter today — preserved.
WITH
  ci_filtered AS (
    SELECT "collectionId", "imageId", "postId", "modelId", "articleId"
    FROM "CollectionItem"
    WHERE "collectionId" IN ($1) AND "status" = 'ACCEPTED'
  ),
  image_levels AS (
    SELECT ci."collectionId", bit_or(i."nsfwLevel") AS lvl
    FROM ci_filtered ci
    JOIN "Image" i ON i.id = ci."imageId"
    WHERE ci."imageId" IS NOT NULL
    GROUP BY ci."collectionId"
  ),
  post_levels AS (
    SELECT ci."collectionId", bit_or(p."nsfwLevel") AS lvl
    FROM ci_filtered ci
    JOIN "Post" p ON p.id = ci."postId" AND p."publishedAt" IS NOT NULL
    WHERE ci."postId" IS NOT NULL
    GROUP BY ci."collectionId"
  ),
  model_levels AS (
    SELECT ci."collectionId", bit_or(m."nsfwLevel") AS lvl
    FROM ci_filtered ci
    JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
    WHERE ci."modelId" IS NOT NULL
    GROUP BY ci."collectionId"
  ),
  article_levels AS (
    SELECT ci."collectionId", bit_or(a."nsfwLevel") AS lvl
    FROM ci_filtered ci
    JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
    WHERE ci."articleId" IS NOT NULL
    GROUP BY ci."collectionId"
  ),
  combined AS (
    SELECT "collectionId", lvl FROM image_levels
    UNION ALL SELECT "collectionId", lvl FROM post_levels
    UNION ALL SELECT "collectionId", lvl FROM model_levels
    UNION ALL SELECT "collectionId", lvl FROM article_levels
  ),
  rolled AS (
    SELECT "collectionId" AS id, bit_or(lvl) AS "nsfwLevel"
    FROM combined
    GROUP BY "collectionId"
  )
UPDATE "Collection" c
SET "nsfwLevel" = (CASE WHEN c."nsfw" THEN 28 ELSE COALESCE(r."nsfwLevel", 0) END)
FROM (
  SELECT c2.id, r."nsfwLevel"
  FROM "Collection" c2
  LEFT JOIN rolled r ON r.id = c2.id
  WHERE c2.id IN ($1) AND c2."availability" = 'Public'
) r
WHERE c.id = r.id
  AND c."nsfwLevel" IS DISTINCT FROM
      (CASE WHEN c."nsfw" THEN 28 ELSE COALESCE(r."nsfwLevel", 0) END)
RETURNING c.id;


-- ----------------------------------------------------------------------------
-- IDEA 2 — Per-level EXISTS short-circuit (Justin's idea from transcript)
-- ----------------------------------------------------------------------------
-- We don't need to scan every item — we only need "does any level-N item
-- exist in this collection?" EXISTS lets Postgres stop at the first hit.
--
-- 5 levels (1, 2, 4, 8, 16) × 4 types = 20 cheap index probes per collection.
-- For big collections, this beats full scans when most levels hit early.
-- For small collections, it's ~equivalent (one row either way).
--
-- Trade-off: query text is longer and per-collection only — doesn't batch
-- nicely. Best for single-collection triggers / hot-path updates, not the
-- bulk backfill job.
SELECT c.id,
  (CASE WHEN c."nsfw" THEN 28 ELSE
    (CASE WHEN EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON i.id = ci."imageId"
      LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
      LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
      LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
      WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
        AND COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) = 1
    ) THEN 1 ELSE 0 END)
    |
    (CASE WHEN EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON i.id = ci."imageId"
      LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
      LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
      LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
      WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
        AND COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) = 2
    ) THEN 2 ELSE 0 END)
    |
    (CASE WHEN EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON i.id = ci."imageId"
      LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
      LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
      LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
      WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
        AND COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) = 4
    ) THEN 4 ELSE 0 END)
    |
    (CASE WHEN EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON i.id = ci."imageId"
      LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
      LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
      LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
      WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
        AND COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) = 8
    ) THEN 8 ELSE 0 END)
    |
    (CASE WHEN EXISTS (
      SELECT 1 FROM "CollectionItem" ci
      LEFT JOIN "Image" i ON i.id = ci."imageId"
      LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
      LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
      LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
      WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
        AND COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) = 16
    ) THEN 16 ELSE 0 END)
  END) AS "nsfwLevel"
FROM "Collection" c
WHERE c.id IN ($1) AND c."availability" = 'Public';


-- ----------------------------------------------------------------------------
-- IDEA 3 — LATERAL scalar subqueries per type (one pass per type, no UNION)
-- ----------------------------------------------------------------------------
-- Per-collection, four small aggregates via LATERAL. Planner gets clean per-
-- type stats. Reads well. Same big-O as Idea 1 but no UNION wiring.
SELECT c.id,
  COALESCE(img.lvl, 0)
    | COALESCE(pst.lvl, 0)
    | COALESCE(mdl.lvl, 0)
    | COALESCE(art.lvl, 0) AS "nsfwLevel"
FROM "Collection" c
LEFT JOIN LATERAL (
  SELECT bit_or(i."nsfwLevel") AS lvl
  FROM "CollectionItem" ci
  JOIN "Image" i ON i.id = ci."imageId"
  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED' AND ci."imageId" IS NOT NULL
) img ON TRUE
LEFT JOIN LATERAL (
  SELECT bit_or(p."nsfwLevel") AS lvl
  FROM "CollectionItem" ci
  JOIN "Post" p ON p.id = ci."postId" AND p."publishedAt" IS NOT NULL
  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED' AND ci."postId" IS NOT NULL
) pst ON TRUE
LEFT JOIN LATERAL (
  SELECT bit_or(m."nsfwLevel") AS lvl
  FROM "CollectionItem" ci
  JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED' AND ci."modelId" IS NOT NULL
) mdl ON TRUE
LEFT JOIN LATERAL (
  SELECT bit_or(a."nsfwLevel") AS lvl
  FROM "CollectionItem" ci
  JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
  WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED' AND ci."articleId" IS NOT NULL
) art ON TRUE
WHERE c.id IN ($1) AND c."availability" = 'Public';


-- ----------------------------------------------------------------------------
-- IDEA 4 — Hybrid: EXISTS probe on level 28 (any-NSFW) first, then full scan
-- ----------------------------------------------------------------------------
-- Almost all collections are either fully-PG or contain some NSFW. If we can
-- cheaply answer "does this collection have ANY item with level & 28 != 0?"
-- we can short-circuit the majority (green-only) in one index hit and only
-- do the expensive bit_or for the rest.
--
-- Useful for bulk backfill: huge collections that are 100% PG get settled
-- fast; only mixed ones pay for the per-type scan.
WITH
  probe AS (
    SELECT c.id,
      EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        LEFT JOIN "Image" i ON i.id = ci."imageId"
        LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
        LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
        LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
        WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
          AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & 28) != 0
      ) AS has_nsfw,
      EXISTS (
        SELECT 1 FROM "CollectionItem" ci
        LEFT JOIN "Image" i ON i.id = ci."imageId"
        LEFT JOIN "Post"  p ON p.id = ci."postId"  AND p."publishedAt" IS NOT NULL
        LEFT JOIN "Model" m ON m.id = ci."modelId" AND m."status" = 'Published'
        LEFT JOIN "Article" a ON a.id = ci."articleId" AND a."publishedAt" IS NOT NULL
        WHERE ci."collectionId" = c.id AND ci.status = 'ACCEPTED'
          AND (COALESCE(i."nsfwLevel", p."nsfwLevel", m."nsfwLevel", a."nsfwLevel", 0) & 1) != 0
      ) AS has_pg
    FROM "Collection" c
    WHERE c.id IN ($1) AND c."availability" = 'Public'
  )
-- Shortcut: green-only (has_pg, no nsfw) → write 1 immediately.
-- Otherwise, fall through to the full rollup (Idea 1 or 3).
SELECT
  id,
  CASE
    WHEN has_nsfw = FALSE AND has_pg = TRUE THEN 1           -- pure PG, done
    WHEN has_nsfw = FALSE AND has_pg = FALSE THEN 0          -- empty / unrated
    ELSE NULL                                                -- needs full rollup
  END AS "nsfwLevel",
  has_nsfw, has_pg
FROM probe;


-- ----------------------------------------------------------------------------
-- IDEA 5 — Trigger-maintained count table (denorm, for reference / comparison)
-- ----------------------------------------------------------------------------
-- Side table: one row per (collectionId, level), stores count.
-- Read = trivial (SELECT bit_or(level) WHERE count > 0).
-- Write = triggers on CollectionItem INSERT/UPDATE/DELETE + on Image/Post/
--         Model/Article nsfwLevel change (propagation).
--
-- CREATE TABLE "CollectionLevelCount" (
--   "collectionId" INT NOT NULL,
--   "level"        INT NOT NULL,          -- 1, 2, 4, 8, 16
--   "count"        INT NOT NULL DEFAULT 0,
--   PRIMARY KEY ("collectionId", "level")
-- );
--
-- Read query (milliseconds, indexed):
SELECT "collectionId", COALESCE(bit_or("level") FILTER (WHERE "count" > 0), 0) AS "nsfwLevel"
FROM "CollectionLevelCount"
WHERE "collectionId" IN ($1)
GROUP BY "collectionId";
--
-- Full cost lives in the write-side triggers. Fragility risk: missed
-- propagation path → counts drift → drift is invisible. Mitigation = periodic
-- reconciler (weekly cron that recomputes from source and fixes drift),
-- which effectively makes this an optimisation on top of Idea 1/3 rather
-- than a replacement.


-- ============================================================================
-- Suggested benchmark matrix (run each via postgres-query skill)
-- ============================================================================
-- Pick sample collection ids:
--   small  (<50 items)
--   medium (~500 items)
--   big    (~5000 items)
--   huge   (>20000, e.g. featured images / big contest)
--
-- For each size, EXPLAIN (ANALYZE, BUFFERS) each of baseline / idea 1 / idea 2
-- / idea 3 / idea 4. Record: exec time, shared-buffer hits, planner choice.
--
-- Correctness smoke: for 50 random collections, all ideas must return the
-- same nsfwLevel (modulo the baseline's LIMIT 50 bug — ideas should diverge
-- from baseline on big collections; that divergence is the fix).
-- ============================================================================
