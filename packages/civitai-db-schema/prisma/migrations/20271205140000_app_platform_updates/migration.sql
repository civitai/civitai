-- App Blocks: platform updates. One row per change Civitai staff (a moderator) pushed to someone
-- else's app: a commit on its own branch of the app's SOURCE repo (`civitai-apps-src/<slug>`),
-- never the build repo. The owner's CLI and App Assistant read the pending rows and merge the
-- branch. The row is what makes an update "from verified Civitai staff": a commit's author and
-- trailers are text anyone can write, so nothing reads them as proof.
--
-- Append-only audit trail: rows are never deleted; a status change records who made it and when.
--
-- NOT AUTO-APPLIED: a human runs this file by hand, dev first, then production. Until it exists
-- (and the `app-blocks-platform-updates` flag is on) the feature is off: every read treats a
-- missing table as "no updates" and every write refuses.
--
-- Written and read by raw SQL only (`app-platform-update.service.ts`); the Prisma model is
-- `@no-type`. No foreign keys, so it locks no other table. Additive and idempotent; safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_platform_updates" (
    -- apu_<ULID>
    "id" TEXT NOT NULL,
    "app_block_id" TEXT NOT NULL,
    -- The app's slug (its blockId), also the source repo's name.
    "slug" TEXT NOT NULL,
    -- The moderator who pushed it. Resolved from the session, never from a request body.
    "staff_user_id" INTEGER NOT NULL,
    -- Why, in the moderator's words. Shown to the owner.
    "reason" TEXT NOT NULL,
    -- The source-repo branch the update was committed to, and the commit.
    "branch" TEXT NOT NULL,
    "base_commit_sha" TEXT NOT NULL,
    "commit_sha" TEXT NOT NULL,
    -- [{ "path": "...", "operation": "create" | "update" | "delete" }]
    "paths" JSONB NOT NULL,
    -- true when this update created the source repo (seeded from the latest approved version).
    "seeded_source_repo" BOOLEAN NOT NULL DEFAULT false,
    -- 'pending' | 'merged' | 'conflicted' | 'superseded'
    "status" TEXT NOT NULL DEFAULT 'pending',
    -- The owner's merge commit, reported by their CLI or App Assistant when status = 'merged'.
    "merge_commit_sha" TEXT,
    -- Who last changed the status, and when.
    "resolved_by_user_id" INTEGER,
    "resolved_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_platform_updates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_platform_updates_status_check"
        CHECK ("status" IN ('pending', 'merged', 'conflicted', 'superseded')),
    CONSTRAINT "app_platform_updates_reason_check"
        CHECK (char_length(btrim("reason")) BETWEEN 1 AND 2000),
    CONSTRAINT "app_platform_updates_slug_check"
        CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$')
);

CREATE INDEX IF NOT EXISTS "app_platform_updates_app_status_idx"
    ON "app_platform_updates" ("app_block_id", "status", "created_at" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "app_platform_updates_slug_commit_idx"
    ON "app_platform_updates" ("slug", "commit_sha");
