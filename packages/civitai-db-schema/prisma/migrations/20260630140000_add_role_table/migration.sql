-- Role definitions (prisma model "Role"). `id` is the app-namespaced role string (e.g. "moderator:volunteer")
-- that "UserRole".role references. Lets a role exist before it has members. Applied manually. Idempotent.

CREATE TABLE IF NOT EXISTS "Role" (
    "id" TEXT NOT NULL,
    "description" TEXT,
    "createdById" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Role_createdById_fkey') THEN
    ALTER TABLE "Role"
      ADD CONSTRAINT "Role_createdById_fkey"
      FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Surface the legacy "tester" role (read by the OAuth /authorize gate) so it's manageable on /admin/roles.
INSERT INTO "Role" ("id", "description")
VALUES ('tester', 'OAuth tester allowlist — apps set to "testers only" let these users log in.')
ON CONFLICT ("id") DO NOTHING;

-- Backfill a Role for every role already assigned, so existing assignments satisfy the FK below.
INSERT INTO "Role" ("id")
SELECT DISTINCT "role" FROM "UserRole"
ON CONFLICT ("id") DO NOTHING;

-- Formalize UserRole.role -> Role.id. Safe: the auth roles lib is the sole writer of UserRole.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'UserRole_role_fkey') THEN
    ALTER TABLE "UserRole"
      ADD CONSTRAINT "UserRole_role_fkey"
      FOREIGN KEY ("role") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
