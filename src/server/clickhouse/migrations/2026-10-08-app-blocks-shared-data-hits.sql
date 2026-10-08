-- App Blocks shared-storage `data` / counter-key moderation hit list — ClickHouse DDL.
-- Apply MANUALLY (we do not auto-run DDL; same policy as the Postgres migrations).
--
-- 🔴 APPLY BEFORE turning on either flag `app-blocks-shared-data-moderation` or
-- `app-blocks-shared-data-moderation-enforce`. Both ship OFF, and with both off nothing writes
-- here. Written by a DIRECT insert from the app (src/server/services/apps/shared-data-moderation.ts),
-- not through civitai-clickhouse-tracker, so there is no tracker schema cache to restart and no
-- enum column for it to reject. ⚠️ The shared client inserts with `wait_for_async_insert: 0`, so a
-- server-side rejection is NOT guaranteed to reach the app: an insert into a missing table may be
-- dropped with no error logged. The write being moderated is never affected either way.
--
-- POST-APPLY CHECK (the only proof rows land): turn on the shadow flag for ONE app, write a
-- `data` blob containing a term the local checks are known to flag, then
--   SELECT count() FROM default.appBlocksSharedDataHits WHERE time > now() - INTERVAL 1 HOUR
-- must be non-zero. A zero without that positive write proves nothing.
--
-- One row per flagged leaf: a string value or object key inside a shared row's `data` blob, or a
-- counter key.
--
-- 🔴 USER TEXT EXISTS ONLY ON SHADOW-MODE ROWS. A row written by a scan that ran because the shadow
-- flag is on and enforce is off (the soak) stores user text so a reviewer can judge the hit rate
-- before the enforce flip: the leaf (`leafText`, cut to 1 KB), the key (`rowKey` — a counter key is
-- app/user-chosen), the path (`leafPath`, built from user-written object keys) and the detector's
-- term (`matched` — for link and audit_regex a substring of the leaf). It is user content that was
-- already visible to the app's other users.
--
-- A row written in ENFORCE mode stores NO user text in ANY column:
--   rowKey      ''  (rowKeySha256 still joins it to the row)
--   leafPath    the same shape with every object key replaced by '#' + 16 hex of its sha256;
--               array indices kept
--   matched     a platform-authored label only: the category, the POI list word, the blocklist
--               entry, the audit trigger's category, the cap, or '' for a link
--   leafText    ''
-- The remaining columns are the same in both modes: a hash, a number, or a platform value.
--
-- That is why this table — and not a log stream — holds the text: the TTL below is its retention,
-- enforced here, in the DDL. Every stored text is therefore gone at most 30 days (plus the merge
-- lag below) after the soak ends, and leaving enforce on does not accumulate any.
--
-- Retention: rows expire 30 days after the start of the day they were written, and
-- `ttl_only_drop_parts` drops each daily partition whole once all of it has expired. So a row lives
-- at most 30 days plus the TTL merge scheduler's lag (`merge_with_ttl_timeout`, 4 h by default),
-- never longer. Enforce-mode rows (no text) expire on the same rolling TTL.
--
-- The per-write DENOMINATOR (writes scanned, leaves per write, counts per category, no text) is
-- NOT here — it is the `app-blocks-shared-data-moderation-scan` Axiom event, one per scanned write.

CREATE TABLE IF NOT EXISTS default.appBlocksSharedDataHits
(
  time DateTime64(3),
  appBlockId String,
  -- the shared row written to, or the counter key — SHADOW-mode rows only (a counter key, and an
  -- updated counter-anchor row's key, are user-chosen text); '' on every enforce-mode row, and for a
  -- create that enforce mode rejected (it never got a key)
  rowKey String,
  -- sha256 hex of the key, in BOTH modes; '' when there is no key
  rowKeySha256 String,
  -- append | update | counter
  surface LowCardinality(String),
  -- shadow | enforce
  mode LowCardinality(String),
  -- 1 when the write this hit came from was rejected (enforce mode only). A pattern-list hit can
  -- be 0 in enforce mode: it rejects only while `user-content-pattern-enforce` is on.
  blocked UInt8,
  -- path inside `data`, cut to 512 bytes; empty for a counter key or a blob-level overflow.
  -- shadow: JSON-pointer-style, built from user-authored keys. enforce: every key replaced by
  -- '#' + 16 hex of its sha256, array indices kept
  leafPath String,
  -- value | key; empty for a blob-level overflow (depth | leaves | chars)
  leafKind LowCardinality(String),
  -- minor | poi | link | pattern | audit_regex | overflow
  category LowCardinality(String),
  -- shadow: the matched term as the detector reported it (for link and audit_regex, user text).
  -- enforce: a platform-authored label only (see the header). For an overflow, in both modes, which
  -- cap: depth | leaves | chars | audit_budget | leaf_length
  matched String,
  leafLength UInt32,
  leafSha256 String,
  -- the leaf as stored, cut to 1 KB — SHADOW-mode rows only; '' on every enforce-mode row
  leafText String
)
ENGINE = MergeTree
PARTITION BY toYYYYMMDD(time)
ORDER BY (time, appBlockId)
TTL toStartOfDay(time) + INTERVAL 30 DAY
SETTINGS ttl_only_drop_parts = 1;

-- Hit rate by category over the last day, against the denominator in Axiom:
--
--   SELECT category, mode, count(), uniqExact(leafSha256) FROM appBlocksSharedDataHits
--   WHERE time > now() - INTERVAL 1 DAY GROUP BY 1, 2 ORDER BY 3 DESC;
--
-- Review queue (shadow-mode rows: the only ones with text), newest first, one row per distinct leaf:
--
--   SELECT any(appBlockId), any(rowKey), category, any(matched), any(leafText), count()
--   FROM appBlocksSharedDataHits WHERE time > now() - INTERVAL 7 DAY AND mode = 'shadow'
--   GROUP BY leafSha256, category ORDER BY max(time) DESC LIMIT 100;
