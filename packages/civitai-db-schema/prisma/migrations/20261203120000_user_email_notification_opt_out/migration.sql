-- Idempotent: applied by hand, possibly more than once. Apply BEFORE deploying the code that reads it.

CREATE TABLE IF NOT EXISTS "UserEmailNotificationOptOut" (
  "userId"    INTEGER      NOT NULL,
  "type"      TEXT         NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserEmailNotificationOptOut_pkey" PRIMARY KEY ("userId", "type"),
  CONSTRAINT "UserEmailNotificationOptOut_userId_fkey" FOREIGN KEY ("userId")
    REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
