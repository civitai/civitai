/**
 * The "User" and "ModActivity" columns `banNoteHoldSql` reads, for PGlite stand-ins that omit them.
 * Creates either table when absent, else adds the columns. Run after the schema's own tables.
 */
export const BAN_NOTE_HOLD_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS "User" (id int PRIMARY KEY);
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS id int,
  ADD COLUMN IF NOT EXISTS meta jsonb,
  ADD COLUMN IF NOT EXISTS "bannedAt" timestamp(3);
CREATE TABLE IF NOT EXISTS "ModActivity" ("entityId" int);
ALTER TABLE "ModActivity"
  ADD COLUMN IF NOT EXISTS "entityType" text,
  ADD COLUMN IF NOT EXISTS "entityId" int,
  ADD COLUMN IF NOT EXISTS activity text,
  ADD COLUMN IF NOT EXISTS "createdAt" timestamp(3);
`;
