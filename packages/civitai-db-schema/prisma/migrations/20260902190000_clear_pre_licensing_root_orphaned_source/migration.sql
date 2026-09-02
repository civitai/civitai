-- The other half of 20260831200000_clear_orphaned_licensing_source: the versions that one
-- deliberately left alone.
--
-- That migration scoped itself to versions created on or after the LicensingRoot table's first rows
-- (2026-07-15 21:56:17 UTC) because an older version may have been offered a checkpoint's root by a
-- retired picker, and clearing one would take income from a creator who chose to earn it. Justin
-- ruled on 2026-09-02 that the state is wrong regardless and is to be corrected, so the carve-out
-- goes (CU 868kwf2fd).
--
-- Measured on prod 2026-09-02: exactly the 23 ids below, out of 1,217,366 versions and 2,128 that
-- carry a source at all. All 23 predate the LicensingRoot table, all are model-type mismatches only
-- (0 also have a base model disagreeing with their source), none lands on a Checkpoint model, and
-- none has been touched since 2026-07-14.
--
-- 🔴 The id list is the scope, and the `NOT EXISTS` is the rule. Both, deliberately:
--
-- A predicate alone does not pin the row set to what was measured. `createdAt` is immutable, so a
-- date bound caps the CANDIDATE POOL, but membership is decided by the subquery, which reads
-- `LicensingRoot` and `Model."type"` at whatever moment a human runs this -- days after the count in
-- this header was taken. Nothing in this workspace writes `LicensingRoot`; its rows are inserted and
-- corrected out of band, during work like this ticket. So one root deleted or one root's `modelType`
-- corrected makes pre-cutoff stamps that pass today stop passing, and a bounded-but-unlisted
-- statement would sweep them with no version and no model having moved.
--
-- The subquery is kept anyway rather than trusting the ids alone: a row that the app repaired in the
-- meantime -- this ticket's own guard now coerces a stored source on saves that omit it -- simply
-- fails `IS NOT NULL` and is skipped. So the statement can only ever clear FEWER than 23, never
-- more, whenever it is run.
--
-- Re-count before applying. If it is not 23, that is a real change in the data and worth
-- understanding before proceeding, not a number to update in place.
--
-- `ModelVersion."createdAt"` is `timestamp without time zone` holding UTC, so a date bound must be a
-- TIMESTAMP literal -- a TIMESTAMPTZ one resolves through the applying session's unpinned TimeZone.
-- The bound is gone from the statement below; the note is kept because the sibling migration has one
-- and the next person writing a variant of this will need it.
--
-- Raw SQL does not fire Prisma's `@updatedAt`, so nothing invalidates the caches the fee is read
-- from. POST the ids this actually cleared to /api/v1/model-versions/bust-cache as one `versionIds`
-- array (max 500) after applying, as a moderator -- a non-moderator session only busts its own
-- versions.
UPDATE "ModelVersion" mv
SET "licensingSourceVersionId" = NULL
WHERE mv."licensingSourceVersionId" IS NOT NULL
  AND mv.id IN (
    3001834, 3122576, 3122651, 3122705, 3123614, 3123669, 3123677, 3123778,
    3124300, 3124306, 3124342, 3124358, 3124413, 3124424, 3124444, 3124466,
    3124481, 3124505, 3125207, 3126724, 3126789, 3128798, 3129603
  )
  AND NOT EXISTS (
    SELECT 1
    FROM "LicensingRoot" lr
    JOIN "Model" m ON m.id = mv."modelId"
    WHERE lr."modelVersionId" = mv."licensingSourceVersionId"
      AND lr."baseModel" = mv."baseModel"
      AND lr."modelType" = m."type"
  );
