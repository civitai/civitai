-- `collectionAiReviewEvents` observation columns — ClickHouse DDL.
--
-- 🔴 MANUAL, and BEFORE the app code that sends these keys merges. We do not auto-run DDL (same
-- policy as the Postgres migrations). The tracker rejects a whole batch that carries a key the
-- table lacks, so code that sends them ahead of this DDL loses audit rows.
--
-- Adds, to `default.collectionAiReviewEvents`:
--   - `nsfwLevel`: the image's level when the decision was made. Rows written before this column
--     existed read 0, as does an image with no level, so bound reads by the deploy time.
--   - five observations from the model's response: `minorUncertain`, `depictsMinor`,
--     `isPhotorealistic`, `suggestiveStyling`, `sexualContent`. 1 = true, 0 = false, -1 = no
--     readable answer (no model call, an unreadable response, or the field left out).
--
-- Additive and metadata-only: ADD COLUMN with a constant DEFAULT on a MergeTree-family table writes
-- no data and schedules no mutation; existing parts read the defaults. Code that does not send the
-- keys is unaffected once they exist.
--
-- 🔴 APPLYING THE DDL IS HALF THE OPERATION. `civitai-clickhouse-tracker` reads the column schema
-- when its pods connect and never again, so until they restart it does not know the new columns.
-- See ./README.md.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
--
-- Rollback: revert the app code; the columns can stay. To drop them, first make sure nothing sends
-- them, then DROP COLUMN each and restart the tracker as in POST-APPLY.

-- Verify, AFTER applying:
--
--   SHOW CREATE TABLE default.collectionAiReviewEvents;
--     -- must show the six columns below with their defaults, and every existing column unchanged.
--
-- Before the app code merges, once the tracker is restarted: confirm a row of today's shape still
-- lands (the next job run writes one within 15 minutes of any pending review):
--
--   SELECT max(createdAt) FROM default.collectionAiReviewEvents
--   WHERE createdAt > now() - INTERVAL 1 HOUR;
--
-- Positive control after the app code is live: the next decision rows carry the new values.
--
--   SELECT count(), countIf(sexualContent != -1), countIf(nsfwLevel > 0)
--   FROM default.collectionAiReviewEvents
--   WHERE createdAt > now() - INTERVAL 1 HOUR;
--     -- both countIf values must be non-zero once a decision with a model call is logged.

-- No trailing semicolon and nothing after the statement: ClickHouse rejects the file as a
-- multi-statement query otherwise, so it can be run as-is.
--
ALTER TABLE default.collectionAiReviewEvents
  ADD COLUMN IF NOT EXISTS `nsfwLevel` UInt8 DEFAULT 0,
  ADD COLUMN IF NOT EXISTS `minorUncertain` Int8 DEFAULT -1,
  ADD COLUMN IF NOT EXISTS `depictsMinor` Int8 DEFAULT -1,
  ADD COLUMN IF NOT EXISTS `isPhotorealistic` Int8 DEFAULT -1,
  ADD COLUMN IF NOT EXISTS `suggestiveStyling` Int8 DEFAULT -1,
  ADD COLUMN IF NOT EXISTS `sexualContent` Int8 DEFAULT -1
