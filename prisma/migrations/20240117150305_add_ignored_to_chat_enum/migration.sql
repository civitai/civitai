-- AlterEnum
ALTER TYPE "ChatMemberStatus" ADD VALUE 'Ignored';

-- AlterTable
ALTER TABLE "ChatMember" ADD COLUMN "ignoredAt" TIMESTAMP(3);

-- AlterEnum
BEGIN;
ALTER TYPE "ChatMessageType" ADD VALUE 'Markdown';
COMMIT;

BEGIN;
ALTER TABLE "ChatMessage" ALTER COLUMN "contentType" DROP DEFAULT;
UPDATE "ChatMessage" SET "contentType" = 'Markdown' WHERE "contentType" = 'markdown';
ALTER TYPE "ChatMessageType" RENAME TO "ChatMessageType_old";
CREATE TYPE "ChatMessageType" AS ENUM ('Markdown');
ALTER TABLE "ChatMessage" ALTER COLUMN "contentType" TYPE "ChatMessageType" USING ("contentType"::text::"ChatMessageType");
DROP TYPE "ChatMessageType_old";
ALTER TABLE "ChatMessage" ALTER COLUMN "contentType" SET DEFAULT 'Markdown';
COMMIT;
