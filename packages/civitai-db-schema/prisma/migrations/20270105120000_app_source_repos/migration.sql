-- App Blocks: source repos. One row per app that has a developer-facing git repo
-- (`civitai-apps-src/<slug>` on the platform git host): a fork (created at fork start) or an App
-- Assistant app (created at its first save). The repo holds the developer's history; it never builds
-- and never files a publish request. The build repo of approved snapshots is unchanged.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Until it exists, every source-repo feature is off (fork start, App Assistant saves and
-- `civitai app pull` behave as before); nothing else reads or writes the table.
--
-- Written and read by raw SQL only (`app-source-repo.service.ts`); the Prisma model is `@no-type`.
-- No foreign keys, so it locks no other table. Additive and idempotent; safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_source_repos" (
    -- The app's slug (its blockId); also the repo name.
    "slug" TEXT NOT NULL,
    -- Who may use the repo while no app block is bound to it (before the first approval).
    "owner_user_id" INTEGER NOT NULL,
    -- Set once an app block with the same owner exists; from then on the block's owner and its
    -- accepted collaborators decide access, and "owner_user_id" no longer does.
    "app_block_id" TEXT,
    -- 'fork' | 'assistant' | 'backfill'.
    "origin" TEXT NOT NULL,
    -- A fork's parent, resolved by the server (never from a manifest or a request body).
    "forked_from_app_block_id" TEXT,
    "forked_from_commit_sha" TEXT,
    -- path -> git blob sha of the files the platform last wrote for App Assistant: the base its
    -- next save is compared against, so a file only the developer changed is never overwritten.
    "assistant_tree" JSONB,
    "last_assistant_commit_sha" TEXT,
    -- The branch the last App Assistant save landed on ('main', or the side branch on a conflict).
    "last_assistant_branch" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_source_repos_pkey" PRIMARY KEY ("slug"),
    CONSTRAINT "app_source_repos_origin_check" CHECK ("origin" IN ('fork', 'assistant', 'backfill')),
    CONSTRAINT "app_source_repos_slug_check" CHECK ("slug" ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$')
);

CREATE INDEX IF NOT EXISTS "app_source_repos_owner_idx" ON "app_source_repos" ("owner_user_id");
CREATE INDEX IF NOT EXISTS "app_source_repos_app_block_idx" ON "app_source_repos" ("app_block_id");
