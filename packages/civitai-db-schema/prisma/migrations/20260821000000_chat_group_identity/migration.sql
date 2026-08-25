-- Group chats: identity moves from the member-set hash to the row id.
--
-- `Chat.hash` stays the dedupe key for 1:1 conversations, so re-opening a DM
-- still returns the existing thread. Groups carry NULL instead — Postgres treats
-- nulls as distinct in a unique index, so any number of groups can hold the same
-- people, and adding or removing a member no longer rewrites a constrained value.

ALTER TABLE "Chat" ADD COLUMN "isGroup" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat" ADD COLUMN "name" TEXT;
ALTER TABLE "Chat" ALTER COLUMN "hash" DROP NOT NULL;

-- Existing 3+ member threads become real groups and release their hash, so the
-- first membership change on one cannot collide with another identical set.
UPDATE "Chat" c
SET "isGroup" = true, "hash" = NULL
WHERE (SELECT COUNT(*) FROM "ChatMember" m WHERE m."chatId" = c."id") > 2;
