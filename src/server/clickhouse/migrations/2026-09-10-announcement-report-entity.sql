-- reports.entityType — add 'announcement'. ClickHouse DDL.
--
-- Apply this MANUALLY. We do not auto-run DDL (same policy as the Postgres migrations).
--
-- ✅ COLUMN APPLIED 2026-09-11: `default.reports.entityType` carries 'announcement' = 17.
-- 🔴 The tracker-restart half is NOT recorded. Treat "is the tracker actually writing this
-- value" as OPEN until the positive control below returns non-zero — the same status section 5
-- of ./2026-09-07-reaction-report-enum-widening.sql carries.
--
-- WHY. `ReportEntity` (src/shared/utils/report-helpers.ts) gains 'announcement', which
-- `createReportHandler` emits as `entityType`. The column's newest definition — section 5 of
-- ./2026-09-07-reaction-report-enum-widening.sql — stops at 'model3dReview' = 16.
--
-- 🔴 THE DDL IS HALF THE OPERATION AND THE OTHER HALF FAILS SILENTLY. See ./README.md: the
-- tracker rejects an unknown value client-side, so the send succeeds, the DDL verifies, and the
-- rows never exist — the report still lands in Postgres, so what is lost is moderation
-- analytics, not moderation. Section 5 of the 2026-09-07 file is a third case where the
-- restart was never confirmed.
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

-- POST-APPLY verification. The DDL check alone is what has shipped broken before.
--
--   SHOW CREATE TABLE default.reports;
--     -- `entityType` must show 'announcement' = 17, with 1..16 unchanged.
--
-- Positive control, AFTER the tracker pods have been restarted — file a report against an
-- announcement yourself, then:
--
--   SELECT count() FROM default.reports WHERE entityType = 'announcement';
--     -- 🔴 A zero is ambiguous and must not be read as "fixed" — it is equally consistent
--     -- with "the tracker was never restarted" and with "nobody has reported an announcement
--     -- yet". Filing one yourself is what turns an absence into a real positive control.
--
-- The tracker's own flush log is the third signal; ask an infra owner for the command.
