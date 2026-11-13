-- App Blocks: App Storage permission hooks — the source of every verified hook file, keyed by its
-- own SHA-256. Content-addressed and append-only: a row is written when a version that declares a
-- hook is submitted, pushed or approved (after its bytes hash to the sha the manifest pins), and is
-- never updated, so a reader caching by sha can never go stale. Which app, version and collection
-- uses which sha is the approved manifest itself; nothing here maps them.
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production, BEFORE the hooks feature is switched on. Until it exists, a version that declares a
-- hook is refused at submit and approve with a message naming this migration; nothing else reads
-- or writes the table.
--
-- Written and read by raw SQL only (`storage-hooks.ts`); the Prisma model is `@no-type`. No
-- foreign keys, so it locks no other table. Additive and idempotent; safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_storage_hook_sources" (
    -- Lowercase hex SHA-256 of the file's bytes; the source below hashes to it.
    "sha256" TEXT NOT NULL,
    -- The hook module, as UTF-8 text (at most 65536 bytes; checked before insert).
    "source" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_storage_hook_sources_pkey" PRIMARY KEY ("sha256"),
    CONSTRAINT "app_storage_hook_sources_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "app_storage_hook_sources_size_check" CHECK ("size_bytes" BETWEEN 0 AND 65536)
);
