-- The resolved-placement notification processors read this table once a minute,
-- and nothing serves them. `Placement_resolvedAt_idx` looks like it should: it is
-- keyed on "resolvedAt" and its predicate includes both `targetType = 'image'`
-- and the status, but it is ALSO predicated on `metricCountedAt IS NULL`, which
-- the notification query does not supply and must not — the metric sweep stamps
-- that column on its own schedule, so adding it here would silently drop the
-- notification for every placement the sweep reached first.
--
-- Without this, each run falls back to a scan over every approved placement ever
-- made, which grows monotonically and is read 1,440 times a day.
--
-- CONCURRENTLY, so it cannot lock out placement writes while it builds. Two
-- consequences when running it by hand: it must NOT be wrapped in a transaction,
-- and a cancelled build leaves an INVALID index behind that will not be used and
-- must be dropped before retrying —
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "Placement_resolvedAt_approved_idx"
  ON "Placement" ("resolvedAt")
  WHERE "targetType" = 'image' AND status = 'approved';
