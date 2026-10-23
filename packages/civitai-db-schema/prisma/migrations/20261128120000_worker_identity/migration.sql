-- MANUAL APPLY ONLY, in each environment. Run it with psql in autocommit mode, one statement at a time,
-- NOT inside a transaction: `ADD VALUE` and `CREATE INDEX CONCURRENTLY` refuse to run in a transaction
-- block. Every statement is idempotent, so re-running the file is safe, and a statement that fails on
-- the lock timeout below can simply be run again.
--
-- If the CONCURRENTLY index build is interrupted it leaves an INVALID index behind, which
-- `IF NOT EXISTS` then skips. Check with
--   SELECT indisvalid FROM pg_index WHERE indexrelid = '"ApiKey_workerDeviceId_idx"'::regclass;
-- and if it is false, run `DROP INDEX CONCURRENTLY "ApiKey_workerDeviceId_idx";` and re-run the CREATE.
--
-- Worker identity at the auth hub: workload OAuth clients whose workers trade a device credential for a
-- 15-minute `Worker` token through the token-exchange grant (RFC 8693).
--
-- What this adds:
--   * ApiKeyType value `Worker`, for the tokens that grant issues.
--   * `WorkerClient`: per-pool config for a workload OauthClient (orchestrator provider, accepted Salad
--     container groups). Deleted with its OauthClient.
--   * `WorkerDevice`: the device registry, unique on (clientId, issuer, subject). Deleted with its client.
--   * `ApiKey.workerDeviceId`: the device a Worker token was issued to. Deleted with its device.
--   * Role `system:workload` and a `system-workers` user holding it, to own the workload clients. The hub
--     produces no session for a holder of that role. Signup never produces a username with a hyphen.
--
-- ORDER: deploy the main app and the hub with the regenerated Prisma client (which knows `Worker`) BEFORE
-- applying this. Nothing writes a `Worker` row until a WorkerClient exists, and none exists until an
-- operator creates one after both steps.

SET lock_timeout = '3s';

ALTER TYPE "ApiKeyType" ADD VALUE IF NOT EXISTS 'Worker';

CREATE TABLE IF NOT EXISTS "WorkerClient" (
  "clientId" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "subjectTokenTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "saladContainerGroupIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkerClient_pkey" PRIMARY KEY ("clientId"),
  CONSTRAINT "WorkerClient_clientId_fkey" FOREIGN KEY ("clientId")
    REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "WorkerDevice" (
  "id" SERIAL NOT NULL,
  "clientId" TEXT NOT NULL,
  "issuer" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastIp" TEXT,
  "blockedAt" TIMESTAMP(3),
  "blockedReason" TEXT,
  CONSTRAINT "WorkerDevice_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkerDevice_clientId_fkey" FOREIGN KEY ("clientId")
    REFERENCES "OauthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "WorkerDevice_clientId_issuer_subject_key"
  ON "WorkerDevice" ("clientId", "issuer", "subject");

-- Nullable with no default: a metadata-only change.
ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "workerDeviceId" INTEGER;

-- ApiKey is large. Add the FK without scanning (NOT VALID), then validate it separately: VALIDATE takes a
-- lock that does not block reads or writes.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ApiKey_workerDeviceId_fkey') THEN
    ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workerDeviceId_fkey" FOREIGN KEY ("workerDeviceId")
      REFERENCES "WorkerDevice"("id") ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE "ApiKey" VALIDATE CONSTRAINT "ApiKey_workerDeviceId_fkey";

CREATE INDEX CONCURRENTLY IF NOT EXISTS "ApiKey_workerDeviceId_idx" ON "ApiKey" ("workerDeviceId");

INSERT INTO "Role" ("id", "description")
VALUES ('system:workload', 'Owner of workload OAuth clients. A holder cannot sign in.')
ON CONFLICT ("id") DO NOTHING;

-- The role goes only to a user this statement created. If `system-workers` is already taken, nothing is
-- inserted; pick another name rather than granting the role to an existing account.
WITH created AS (
  INSERT INTO "User" ("username")
  VALUES ('system-workers')
  ON CONFLICT ("username") DO NOTHING
  RETURNING "id"
)
INSERT INTO "UserRole" ("userId", "role", "note")
SELECT "id", 'system:workload', 'Owns workload OAuth clients' FROM created;

RESET lock_timeout;
