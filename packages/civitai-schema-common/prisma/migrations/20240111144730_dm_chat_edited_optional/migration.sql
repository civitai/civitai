-- AlterTable
ALTER TABLE "Chat" ALTER COLUMN "ownerId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ChatMessage" ALTER COLUMN "editedAt" DROP NOT NULL;
