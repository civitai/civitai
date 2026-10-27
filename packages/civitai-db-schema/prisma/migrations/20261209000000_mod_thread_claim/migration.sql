CREATE TABLE "ModThreadClaim" (
  "chatId"      INTEGER      NOT NULL,
  "moderatorId" INTEGER      NOT NULL,
  "claimedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ModThreadClaim_pkey" PRIMARY KEY ("chatId"),
  CONSTRAINT "ModThreadClaim_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ModThreadClaim_moderatorId_fkey" FOREIGN KEY ("moderatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ModThreadClaim_moderatorId_idx" ON "ModThreadClaim"("moderatorId");
