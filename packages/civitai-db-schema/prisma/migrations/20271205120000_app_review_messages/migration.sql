-- ============================================================
-- App review reply thread (app_review_messages)
-- ============================================================
-- The conversation on one app review decision: messages between the app's
-- developer side and Civitai App Review, in both directions, on one publish
-- request. A request is either an on-site version request
-- (app_block_publish_requests) or a store-listing request
-- (app_listing_publish_requests); each message names exactly one of the two
-- through its own FK, so it keeps referential integrity and is deleted with
-- its request.
--
-- recipient_user_id is the individual notified when the message was posted,
-- or NULL when it was routed to the moderator queue or to the developer side.
-- It records who was told at the time, so it carries no FK.
--
-- Applied MANUALLY per environment; nothing auto-applies it. The reply thread
-- does not read or write this table while the `app-review-replies` Flipt flag
-- is off. The personal-data export reads every registered table regardless of
-- the flag: until this is applied, an export marks this one file unavailable
-- (the rest of the export is unaffected). Apply it before (or with) the deploy,
-- and in any case before turning the flag on.
--
-- Idempotent: safe to run more than once.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS "app_review_messages" (
  "id"                         SERIAL         PRIMARY KEY,
  "publish_request_id"         TEXT,
  "listing_publish_request_id" TEXT,
  "author_user_id"             INTEGER,
  "author_role"                TEXT           NOT NULL,
  "body"                       TEXT           NOT NULL,
  "recipient_user_id"          INTEGER,
  "created_at"                 TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "app_review_messages_publish_request_id_fkey"
    FOREIGN KEY ("publish_request_id") REFERENCES "app_block_publish_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "app_review_messages_listing_publish_request_id_fkey"
    FOREIGN KEY ("listing_publish_request_id") REFERENCES "app_listing_publish_requests"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "app_review_messages_author_user_id_fkey"
    FOREIGN KEY ("author_user_id") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  -- Exactly one request per message.
  CONSTRAINT "app_review_messages_one_request_check"
    CHECK (num_nonnulls("publish_request_id", "listing_publish_request_id") = 1),
  CONSTRAINT "app_review_messages_author_role_check"
    CHECK ("author_role" IN ('developer', 'moderator')),
  CONSTRAINT "app_review_messages_body_length_check"
    CHECK (char_length("body") BETWEEN 1 AND 2000)
);

-- One thread, oldest first.
CREATE INDEX IF NOT EXISTS "app_review_messages_publish_request_idx"
  ON "app_review_messages" ("publish_request_id", "created_at");

CREATE INDEX IF NOT EXISTS "app_review_messages_listing_request_idx"
  ON "app_review_messages" ("listing_publish_request_id", "created_at");

-- A user's messages: the personal-data export reads by author.
CREATE INDEX IF NOT EXISTS "app_review_messages_author_idx"
  ON "app_review_messages" ("author_user_id");

COMMIT;
