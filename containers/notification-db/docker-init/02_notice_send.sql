-- Audit for POST /notifications/notices (apps/notifications/src/lib/server/notices.ts).
-- Applied by hand on the notification DB; docker-init runs it on a fresh local container.
SET search_path = public;

-- One row per sendId. contentHash pins (type, message, url): a later call with the same sendId and
-- different content is refused, so a Notification key is never reused for new text.
CREATE TABLE IF NOT EXISTS "NoticeSend" (
    "sendId" text PRIMARY KEY,
    type text NOT NULL,
    message text NOT NULL,
    url text,
    "contentHash" text NOT NULL,
    "sentBy" text NOT NULL,
    "actorUserId" integer,
    reason text NOT NULL,
    credential text NOT NULL,
    requested integer NOT NULL DEFAULT 0,
    queued integer NOT NULL DEFAULT 0,
    "optedOut" integer NOT NULL DEFAULT 0,
    "unknownUser" integer NOT NULL DEFAULT 0,
    "inactiveUser" integer NOT NULL DEFAULT 0,
    "alreadySent" integer NOT NULL DEFAULT 0,
    "dryRuns" integer NOT NULL DEFAULT 0,
    sends integer NOT NULL DEFAULT 0,
    "firstAt" timestamp(3) without time zone NOT NULL DEFAULT now(),
    "lastAt" timestamp(3) without time zone NOT NULL DEFAULT now()
);

-- One row per call; the rolling 24h recipient ceiling sums "queued" over mode = 'send'. A send's row
-- is written before its queue writes, so a failure part-way still counts toward the ceiling.
CREATE TABLE IF NOT EXISTS "NoticeSendCall" (
    id serial PRIMARY KEY,
    "sendId" text NOT NULL REFERENCES "NoticeSend"("sendId") ON DELETE CASCADE,
    mode text NOT NULL,
    requested integer NOT NULL,
    queued integer NOT NULL,
    "sentBy" text NOT NULL,
    reason text NOT NULL,
    credential text NOT NULL,
    "actorUserId" integer,
    "createdAt" timestamp(3) without time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "NoticeSendCall_createdAt_idx" ON "NoticeSendCall" ("createdAt");
CREATE INDEX IF NOT EXISTS "NoticeSendCall_sendId_idx" ON "NoticeSendCall" ("sendId");

-- Leases serialising notice calls: 'send:<sendId>' per send, 'global-send' across sends. Rows rather
-- than advisory locks so they hold behind a transaction-mode pooler; "lockedUntil" frees a lease a
-- crashed call never released.
CREATE TABLE IF NOT EXISTS "NoticeSendLease" (
    name text PRIMARY KEY,
    holder text NOT NULL,
    "lockedUntil" timestamp(3) without time zone NOT NULL
);
