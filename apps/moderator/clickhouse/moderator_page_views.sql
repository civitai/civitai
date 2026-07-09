-- ClickHouse table for moderator page-visit tracking.
--
-- Apply this MANUALLY to the ClickHouse cluster (we don't auto-run DDL — same policy as the Postgres
-- migrations). Written to by apps/moderator/src/lib/server/page-visits.ts via the async-insert client.
--
-- `location` is the SvelteKit route id (route pattern, e.g. `/images` or `/challenges/[id]/edit`), so
-- dynamic-segment pages group to a single row instead of fragmenting per id. ORDER BY (location,
-- visitedAt) keeps per-page grouping + time-range scans cheap; monthly partitions make retention trivial.
-- visitedAt defaults to insert time so the app only sends (userId, location).
--
-- On ClickHouse Cloud, `ENGINE = MergeTree` is auto-promoted to a replicated
-- `SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')` — so `SHOW CREATE TABLE` will
-- report SharedMergeTree even though we declare MergeTree here. (Applied to prod 2026-06-30.)

CREATE TABLE IF NOT EXISTS moderator_page_views
(
  userId    UInt32,
  location  String,
  visitedAt DateTime DEFAULT now()
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(visitedAt)
ORDER BY (location, visitedAt);
-- Optional retention — auto-drop visits older than a year:
--   TTL visitedAt + INTERVAL 1 YEAR;


-- ─────────────────────────────────────────────────────────────────────────────
-- Dead-page discovery
-- ─────────────────────────────────────────────────────────────────────────────

-- Visits per page over the last 30 days (ascending = least-used first):
SELECT location,
       count()           AS visits,
       uniqExact(userId) AS distinct_mods,
       max(visitedAt)    AS last_visit
FROM moderator_page_views
WHERE visitedAt >= now() - INTERVAL 30 DAY
GROUP BY location
ORDER BY visits ASC;

-- Truly dead pages = known moderator routes with ZERO visits in the window. ClickHouse only stores
-- pages that WERE visited, so feed the known route list in and anti-join to surface the absences. Use
-- route-id patterns (matching what the app records), e.g. `/challenges/[id]/edit`:
--
--   SELECT route
--   FROM (SELECT arrayJoin(['/images', '/reports', '/strikes', '/challenges/[id]/edit', /* … */]) AS route)
--   WHERE route NOT IN (
--     SELECT DISTINCT location FROM moderator_page_views
--     WHERE visitedAt >= now() - INTERVAL 30 DAY
--   );
