-- Per-conversation controls: notification level, pin, and the delete-conversation
-- watermark. All three hang off the member row, so each side of a chat controls
-- its own view without touching the other's.

CREATE TYPE "ChatNotifyLevel" AS ENUM ('All', 'Mentions', 'None');

ALTER TABLE "ChatMember" ADD COLUMN "notifyLevel" "ChatNotifyLevel" NOT NULL DEFAULT 'All';
ALTER TABLE "ChatMember" ADD COLUMN "pinnedAt" TIMESTAMP(3);

-- Deleting a conversation stamps this instead of removing rows: the messages stay
-- resolvable, so a ChatReport filed against the thread cannot be detached by
-- either participant clearing their side.
ALTER TABLE "ChatMember" ADD COLUMN "clearedAt" TIMESTAMP(3);

-- isMuted already meant "notifications off for this conversation"; carry those
-- users over so nobody's chat starts making noise again after deploy.
UPDATE "ChatMember" SET "notifyLevel" = 'None' WHERE "isMuted" IS TRUE;
