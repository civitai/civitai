-- reports.entityType — add 'announcement'. ClickHouse DDL.
--
-- Apply this MANUALLY. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- ⏳ NOT YET APPLIED. Apply it BEFORE the branch that adds ReportEntity.Announcement is
-- deployed — and read the restart caveat below, because that ordering rule is necessary and
-- not sufficient.
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains `Announcement = 'announcement'`,
-- and `createReportHandler` emits it as `entityType` on every report event. The column's newest
-- definition, in ./2026-09-07-reaction-report-enum-widening.sql section 5, stops at
-- 'model3dReview' = 16.
--
-- 🔴 THE FAILURE IS SILENT AND CLIENT-SIDE. The app POSTs to the tracker service
-- fire-and-forget; a value the target column does not carry is rejected THERE, while it is
-- serializing the batch, before ClickHouse is ever asked. So the caller sees a successful
-- send, the app logs nothing, `SHOW CREATE TABLE` looks fine, and the rows simply never
-- exist. A dashboard over them reads a clean zero that is indistinguishable from
-- "nobody reported an announcement". The report itself still lands in Postgres — what is lost
-- is the moderation analytics row, not the moderation.
--
-- 🔴 THE DDL IS ONLY HALF THE OPERATION. `civitai-clickhouse-tracker` builds its column
-- serializers from the schema its pods read AT CONNECT TIME and never re-reads them, so a
-- value added after those pods booted is still rejected client-side. See ./README.md — this
-- has shipped broken twice, and section 5 of the 2026-09-07 file is a third case where the
-- restart half was never confirmed.
--
-- `MODIFY COLUMN` REPLACES the whole enum definition, so the statement below restates every
-- existing value at exactly the index it already has and appends at an unused index — a
-- metadata-only ALTER: no data is rewritten and no mutation is scheduled. Do NOT renumber or
-- rename an existing value; that WOULD rewrite the table and silently remap existing rows.
--
-- Independent of every other section in this directory: no materialized view reads `reports`.
--
-- TO ROLL BACK: re-run the statement below with 'announcement' = 17 removed, having first
-- confirmed `SELECT count() FROM default.reports WHERE entityType = 'announcement'` is 0 —
-- narrowing an enum that already carries a value makes those rows unreadable.
--
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.


-- =====================================================================================
-- reports.entityType — adds 'announcement' = 17. Indices 1..16 are unchanged from
-- ./2026-09-07-reaction-report-enum-widening.sql section 5.
-- =====================================================================================

ALTER TABLE default.reports
  MODIFY COLUMN `entityType` Enum8(
    'model' = 1,
    'comment' = 2,
    'commentV2' = 3,
    'image' = 4,
    'resourceReview' = 5,
    'article' = 6,
    'post' = 7,
    'reportedUser' = 8,
    'collection' = 9,
    'bounty' = 10,
    'bountyEntry' = 11,
    'chat' = 12,
    'challenge' = 13,
    'comicProject' = 14,
    'model3d' = 15,
    'model3dReview' = 16,
    'announcement' = 17
  );


-- =====================================================================================
-- POST-APPLY verification. Run both halves; the DDL check alone is what has shipped broken
-- before, and a bare zero from the positive control proves nothing on its own.
-- =====================================================================================
--
--   SHOW CREATE TABLE default.reports;
--     -- `entityType` must show 'announcement' = 17, with 1..16 unchanged.
--
-- Positive control, AFTER the tracker pods have been deleted and come back Ready — file a
-- report against an announcement yourself, then:
--
--   SELECT count() FROM default.reports WHERE entityType = 'announcement';
--     -- No time predicate is needed: the column could not REPRESENT this value before this
--     -- ALTER, so any row carrying it necessarily postdates it.
--     -- 🔴 A zero is ambiguous and must not be read as "fixed" — it is equally consistent
--     -- with "the tracker was never restarted" and with "nobody has reported an announcement
--     -- yet". Filing one yourself is what turns an absence into a real positive control.
--
--   kubectl logs -n civitai-clickhouse-tracker <pod> --since=5m | grep 'Flush reports'
--     -- must read poison=0 dlq=0 for a batch that actually contained the attempt. Immediately
--     -- after a restart it only says no rejectable row was in that batch.
