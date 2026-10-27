-- Creator Services deal file accesses — ClickHouse DDL. Apply MANUALLY, BEFORE the code that writes it
-- deploys. The tracker reads table schemas when it connects, so a table created after it started is
-- unknown to it until it is restarted (ask an infra owner). Then confirm with a real event: download a
-- final of a test deal as its buyer, and
--   SELECT role, kind, count() FROM default.serviceDealFileAccess
--   WHERE time > now() - INTERVAL 1 HOUR GROUP BY role, kind
-- must show a Buyer / Download row. A zero without that download proves nothing.
--
-- One row per download link handed out (signed, not necessarily used). `kind` ModeratorFetch is the
-- moderator dispute tool and never counts as a party's download. Strings, not Enum8: the tracker
-- drops a row whose enum value the column lacks, with nothing logged in the app.
-- No TTL: rows are evidence for a payment dispute.

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
