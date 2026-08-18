# Chat moderation audit — ClickHouse setup

The chat audit log records acts that remove content from the product but not
from the record: a per-message delete and a conversation clear. A `ChatReport`
filed after either has to stay reviewable.

Three things have to exist before it records anything. The app deploys safely
without them — `isFlipt` returns false for an unknown flag, so the write is a
no-op — but **silence in an audit log is indistinguishable from "nothing
happened"**, so treat it as unfinished until all three are done.

## 1. The table — created

```sql
CREATE TABLE IF NOT EXISTS default.chatAuditEvents
(
    `createdAt` DateTime64(3) DEFAULT now64(3),
    `type` LowCardinality(String),        -- 'delete' | 'clear' | 'edit'
    `chatId` Int32,
    `messageId` Int32 DEFAULT 0,          -- 0 for 'clear', which acts on the conversation
    `actorId` Int32,                      -- who performed the act
    `subjectId` Int32,                    -- whose content it was; differs on a moderator delete
    `actorRole` LowCardinality(String),   -- 'owner' | 'moderator'
    `oldValue` String CODEC(ZSTD(3)),
    `newValue` String CODEC(ZSTD(3)),
    `truncated` UInt8 DEFAULT 0
)
ENGINE = SharedMergeTree('/clickhouse/tables/{uuid}/{shard}', '{replica}')
PARTITION BY toYYYYMM(createdAt)
ORDER BY (chatId, createdAt)
SETTINGS index_granularity = 8192
```

Shaped to match `entityChangeEvents`, which is the precedent this log follows:

- **`SharedMergeTree`, not `MergeTree`.** The cluster has two replicas; a plain
  `MergeTree` would exist on whichever node ran the DDL and be missing from the
  other. Verified present on both.
- **`DateTime64(3)`**, so several events in the same second still order, which
  the keyset pagination on the mod page depends on.
- **Signed ints.** Chat system messages use `userId: -1`; `UInt32` would store
  that as 4294967295.
- **`ORDER BY (chatId, createdAt)`** — "what happened in this conversation" is
  the reviewer's first question, so it is a bounded range scan. Filtering by
  `actorId` is a scan; add a skip index if that becomes a common path.

**No TTL, deliberately.** `entityChangeEvents` has none either, and a TTL on an
audit log silently deletes evidence — adding one later is one statement, while
recovering what one removed is impossible. But these rows hold up to 4,000
characters of message body keyed to a user, and account deletion removes the
Postgres copy without touching this one, so **the retention window is an open
privacy decision, not a settled default**:

```sql
ALTER TABLE default.chatAuditEvents MODIFY TTL createdAt + INTERVAL 2 YEAR;
```

## 2. The Flipt flag

`chat-audit-log`, boolean, default off. Turn it on to start recording. It is a
kill-switch, not a ramp — a partially-recorded audit is worse than none, because
a gap reads as an absence of events.

## 3. Verify

Do a delete and a clear in the app, then:

```sql
SELECT * FROM chatAuditEvents ORDER BY createdAt DESC LIMIT 10;
```

## Reading it

`/moderator/chat-audit` — moderator-gated page. Filter by chat id, actor user id
and event type; keyset-paginated. Backed by `chat.getAudit`
(`moderatorProcedure`), which returns empty rather than throwing when ClickHouse
is absent, so the page reads as unconfigured rather than broken in dev.

## Known gaps

- **`edit` has no emitter.** `updateMessage` is still unrouted, so the type is
  declared and unused.
- **Retention is not absolute.** Account deletion and the auto-mute-scam cron
  both hard-delete `ChatMessage` rows from Postgres. The audit row survives with
  its content copy, but the thread around it does not.
- **Not recorded:** kicks, `filteredAt` transitions, notification and pin
  changes, DM-policy changes. Add them if moderation asks for the membership
  story rather than the content one.
