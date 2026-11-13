-- ============================================================
-- AppAccessRequest — "Request access" from the /apps/build pitch
-- ============================================================
-- One ADDITIVE table. Nothing existing is altered and no existing row is touched.
--
-- An `approved` row IS the grant: the auth hub reads "does this user have an approved row" into the
-- session as `appBuilderApproved`, and Flipt's `app-builder-approved` segment matches on it. A
-- moderator declining an approved row revokes it.
--
-- ⚠️ MANUAL APPLY, per environment (psql / retool). Apply BEFORE deploying the code that
-- reads it: the auth hub reads this table on every session it produces, and the pitch reads the
-- viewer's request on every signed-in visit; without the table both reads fail.
--
-- Idempotent: IF NOT EXISTS guards throughout, so a re-run is a no-op.

CREATE TABLE IF NOT EXISTS "AppAccessRequest" (
  "id"           SERIAL       PRIMARY KEY,
  -- ON UPDATE CASCADE matches what Prisma emits for these relations.
  "userId"       INTEGER      NOT NULL REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "whatToBuild"  TEXT         NOT NULL,
  -- TEXT + CHECK rather than an enum, so a new status needs no enum deploy ordering.
  "status"       TEXT         NOT NULL DEFAULT 'pending',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reviewedAt"   TIMESTAMP(3),
  "reviewedById" INTEGER      REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,

  CONSTRAINT "AppAccessRequest_status_check"
    CHECK ("status" IN ('pending', 'approved', 'declined')),
  -- A decided row says who decided and when; a pending row says neither.
  CONSTRAINT "AppAccessRequest_review_check"
    CHECK (("status" = 'pending') = ("reviewedAt" IS NULL))
);

-- One PENDING request per user. A second submit while one is pending is refused. Decided rows are
-- kept as history.
CREATE UNIQUE INDEX IF NOT EXISTS "AppAccessRequest_userId_pending_key"
  ON "AppAccessRequest" ("userId") WHERE "status" = 'pending';

-- The viewer's own latest request, and the hub's "has an approved row" check.
CREATE INDEX IF NOT EXISTS "AppAccessRequest_userId_createdAt_idx"
  ON "AppAccessRequest" ("userId", "createdAt" DESC);
-- The moderator queue: one status, newest first.
CREATE INDEX IF NOT EXISTS "AppAccessRequest_status_createdAt_idx"
  ON "AppAccessRequest" ("status", "createdAt" DESC);
