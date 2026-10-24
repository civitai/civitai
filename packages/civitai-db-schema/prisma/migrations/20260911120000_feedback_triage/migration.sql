-- ============================================================
-- Feedback triage — the columns the moderator queue writes back
-- ============================================================
-- ADDITIVE ONLY. Four NULLable columns, two foreign keys and one index on the
-- existing "Feedback" table. No existing column is altered, no existing row is
-- rewritten, and "Feedback_status_check" is left exactly as
-- `20260813180000_feedback` created it — triage reuses the four statuses that
-- constraint already allows ('new', 'reviewed', 'actioned', 'dismissed'), three
-- of which are unreachable today because nothing has ever read the table.
--
-- ⚠️ MANUAL APPLY. This repo has no `prisma migrate deploy` in any deploy path;
-- a human applies the SQL below per environment (psql / retool). Apply to BOTH:
--   1. prod nvme0   (the live civitai DB)
--   2. the dev clone
--
-- APPLY ORDER: either order is safe, and both happen in practice because the
-- image and the schema are never deployed atomically.
--   * Migration first → a no-op. Nothing reads these columns until the moderator
--                       page ships.
--   * Page first      → the page's own reads fail (42703) until this is applied.
--                       🔴 It is reachable on day one WITHOUT any `/admin` tick:
--                       `allows()` in apps/moderator/src/lib/server/access.ts
--                       short-circuits true for SUPER_ROLE, so every
--                       `moderator:admin` sees the nav entry the moment the page
--                       deploys — and the sidebar badge counts on `status` alone,
--                       so it renders a real number against an unmigrated
--                       database. The page catches that one error code and says
--                       so rather than throwing, so the cost is an unusable queue
--                       and not an error boundary. Nothing user-facing is
--                       affected either way: the submit path does not touch these
--                       columns.
--
-- 🔴 The hazard `20260901120000_app_listing_beta` records — a Prisma call with no
-- explicit `select` emits `RETURNING <every scalar the MODEL declares>` and raises
-- 42703 against a database that has not been migrated — cannot fire here, which is
-- WHY both orders above are safe. There is exactly ONE Prisma access to this table
-- in the whole repo, `createFeedback` in src/server/services/feedback.service.ts,
-- and it passes `select: { id: true }`. Re-check that before relying on it: the
-- guarantee is the explicit select, not the table's obscurity. Add a second Prisma
-- reader without one and this migration becomes ordering-sensitive.
--
-- Idempotent: `IF NOT EXISTS` on every column and index; the two foreign keys go
-- through `pg_constraint` guards, because `ALTER TABLE ... ADD CONSTRAINT` has no
-- `IF NOT EXISTS` form in Postgres.
--
-- `ADD COLUMN ... NULL` with no default is metadata-only in Postgres 11+, so all
-- four are O(1) regardless of row count and safe to apply while the site is up.
-- The FK additions each take a brief ACCESS EXCLUSIVE lock on "Feedback" and a
-- SHARE ROW EXCLUSIVE on the referenced table while they validate; at the table's
-- current size (26 rows, measured 2026-09-11) that is instant. A plain `ADD
-- CONSTRAINT` rather than `NOT VALID` + `VALIDATE` for the same reason
-- `20260910120000_app_user_scope_grant_buzz_budget` gives: every existing row
-- trivially satisfies the predicate, because the column it constrains is created
-- NULL by the statement above it.

-- Moderator-internal triage note: why this was dismissed, what was done about it,
-- which PR fixed it. NOT the text seeded into a Bug — a Bug is public, this is not,
-- and conflating the two is how an internal note reaches the Known Issues board.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "triageNote" TEXT NULL;

-- Who moved it out of 'new', and when. An INTEGER user id, not the TEXT display
-- name `ModerationImageHelp.handledBy` holds — that column is a Retool artefact
-- being preserved deliberately, not a pattern to copy into a new table.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "handledById" INTEGER NULL;
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "handledAt" TIMESTAMP(3) NULL;

-- The promote-to-Bug link. A `bugId` FK rather than a `clickupTaskId`/`clickupUrl`
-- pair: the repo has no outbound ClickUp client and no ClickUp API token, so the
-- only thing this side can create is a "Bug" row. ClickUp status then flows back
-- through the EXISTING inbound webhook (src/pages/api/webhooks/clickup.ts), which
-- writes "Bug"."status" — so the link has to be to the row that webhook updates.
ALTER TABLE "Feedback" ADD COLUMN IF NOT EXISTS "bugId" INTEGER NULL;

-- ON DELETE SET NULL on both, for opposite reasons that land on the same clause.
-- handledById: a moderator account being deleted must not delete the feedback
-- someone else still needs to read, and must not fabricate a different handler.
-- bugId: deleting a Bug un-links the feedback rather than destroying the report
-- that produced it. ON UPDATE CASCADE matches what Prisma emits for a relation on
-- this schema; without it Postgres records NO ACTION and the table lands
-- pre-drifted from `schema.full.prisma`.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_handledById_fkey'
  ) THEN
    ALTER TABLE "Feedback"
      ADD CONSTRAINT "Feedback_handledById_fkey"
      FOREIGN KEY ("handledById") REFERENCES "User"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'Feedback_bugId_fkey'
  ) THEN
    ALTER TABLE "Feedback"
      ADD CONSTRAINT "Feedback_bugId_fkey"
      FOREIGN KEY ("bugId") REFERENCES "Bug"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- The queue's default view is "status = 'new', ALL areas, newest first", and the
-- sidebar badge is `count(*) WHERE status = 'new'`. Neither is served by
-- "Feedback_area_status_createdAt_idx", whose leading column is "area" — that one
-- answers "this area's queue", which is the filtered view, not the default one.
--
-- 🔴 This index is for the table's future, not its present: at 26 rows every plan
-- is a sequential scan and will stay one until the table is orders of magnitude
-- larger. It is here because it is free to add now and awkward to add later, not
-- because anything is slow.
CREATE INDEX IF NOT EXISTS "Feedback_status_createdAt_idx"
  ON "Feedback" ("status", "createdAt" DESC);

-- Deliberately NO index on "bugId". The only read that filters on it is "what else
-- is linked to this Bug", issued once when a moderator opens a row that already
-- has a bugId — a rare path over a small table. Add it when the table is large
-- AND that panel is actually used, not on the guess that it will be.
