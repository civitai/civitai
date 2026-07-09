-- AlterTable
ALTER TABLE "Chat" ADD COLUMN     "ownerId" INTEGER NOT NULL default -1;

-- AddForeignKey
ALTER TABLE "Chat" ADD CONSTRAINT "Chat_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
