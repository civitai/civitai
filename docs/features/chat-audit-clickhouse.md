# Chat moderation audit — ClickHouse setup

The chat audit log records acts that remove content from the product but not
from the record: a per-message delete and a conversation clear. A `ChatReport`
filed after either has to stay reviewable.

Three things have to exist before it records anything. The app deploys safely
without them — `isFlipt` returns false for an unknown flag, so the write is a
no-op — but **silence in an audit log is indistinguishable from "nothing
happened"**, so treat it as unfinished until all three are done.

## 1. The table

```sql
CREATE TABLE IF NOT EXISTS chatAuditEvents
(
    createdAt   DateTime DEFAULT now(),
    type        LowCardinality(String),   -- 'delete' | 'clear' | 'edit'
    chatId      UInt32,
    messageId   UInt32 DEFAULT 0,         -- 0 for 'clear', which acts on the conversation
    actorId     UInt32,                   -- who performed the act
    subjectId   UInt32,                   -- whose content it was; differs on a moderator delete
    actorRole   LowCardinality(String),   -- 'owner' | 'moderator'
    oldValue    String,
    newValue    String,
    truncated   UInt8 DEFAULT 0
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(createdAt)
ORDER BY (chatId, createdAt)
TTL createdAt + INTERVAL 2 YEAR;
```

`ORDER BY (chatId, createdAt)` matches the reviewer's primary question — "what
happened in this conversation" — so that read is a bounded range scan. The
`actorId` lookup is a scan; add a skip index if it gets used often.

Set the TTL deliberately rather than inheriting a default. These rows hold up to
4,000 characters of message body keyed to a user, and account deletion removes
the Postgres copy without touching this one — so the retention window here is a
privacy decision, not a storage one.

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
