CREATE INDEX user_deletedAt_idx ON "User" ("deletedAt");

CREATE INDEX UserEngagement_type_userId ON "UserEngagement" (type, "userId");
