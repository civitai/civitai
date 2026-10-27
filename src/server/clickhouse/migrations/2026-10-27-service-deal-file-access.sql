-- Creator Services deal file accesses — ClickHouse DDL. Apply MANUALLY (we do not auto-run DDL).
--
-- 🔴 APPLY BEFORE the app code that writes it deploys. Rows go through civitai-clickhouse-tracker
-- (`Tracker.serviceDealFileAccess`), which reads table schemas when its pods connect, so a table
-- created after they booted is unknown to it until they restart.
-- POST-APPLY: restart civitai-clickhouse-tracker by pod delete, then confirm with a real event.
--
-- POST-APPLY CHECK: download a final of a test deal as its buyer, then
--   SELECT role, kind, count() FROM default.serviceDealFileAccess
--   WHERE time > now() - INTERVAL 1 HOUR GROUP BY role, kind
-- must show a Buyer / Download row. A zero without that download proves nothing.
--
-- One row per download link handed out (the link is signed, not necessarily used). `role` is the
-- user's relation to the deal: Buyer, Seller, or Moderator for a non-party. `kind` is Download
-- (the site's download route) or ModeratorFetch (the moderator dispute tool), which never counts
-- as a party's download. Strings, not Enum8: the tracker drops a row whose enum value the column
-- lacks, with nothing logged in the app.
--
-- READ PATH: the moderator deal-files endpoint, per deal: WHERE dealId IN (...) GROUP BY fileId,
-- role, kind. No TTL: rows are evidence for a payment dispute.

CREATE TABLE IF NOT EXISTS default.serviceDealFileAccess
(
  time DateTime64(3) DEFAULT now64(3),
  dealId UInt32,
  fileId UInt32,
  userId UInt32,
  role LowCardinality(String),
  kind LowCardinality(String)
)
ENGINE = MergeTree
ORDER BY (dealId, time);
