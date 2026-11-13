-- App hibernate ("Sleeping" apps). One row per sleeping app, per user: where its workspace
-- archive is kept in the archive store, its sha256 and size, and optionally its `.env*` files,
-- stored encrypted (the object, its sha256 and size, and the per-archive data key wrapped by a
-- master key civitai holds).
--
-- NOT AUTO-APPLIED: a human runs this file by hand (see CLAUDE.md -> Database), dev first, then
-- production. Until it exists every hibernation read fails, which the `app-hibernate` flag keeps
-- unreachable, and account deletion treats the absent table as "nothing stored".
--
-- Written and read by raw SQL only (`app-hibernation/hibernation.repo.ts`); the Prisma model is
-- `@no-type`. No foreign keys, so it locks no other table. Additive and idempotent; safe to re-run.

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS "app_sandbox_hibernations" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    -- The app's key in the sandbox service: always a valid app slug.
    "app_key" TEXT NOT NULL,
    -- The hibernation attempt that wrote the row; part of every object key and of the
    -- encryption binding of the secrets.
    "attempt_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "bytes" BIGINT NOT NULL,
    -- What the archiver left out (the export exclusion list it applied).
    "excluded" TEXT[] NOT NULL DEFAULT '{}',
    -- The encrypted `.env*` blob: all four set, or none.
    "secrets_object_key" TEXT,
    "secrets_sha256" CHAR(64),
    "secrets_bytes" BIGINT,
    "secrets_wrapped_key" TEXT,
    -- Why it was hibernated: 'cap' | 'retention' | 'user' (NULL when the caller did not say).
    "reason" TEXT,
    "app_created_at" TIMESTAMPTZ(6),
    "last_activity_at" TIMESTAMPTZ(6),
    "hibernated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_sandbox_hibernations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "app_sandbox_hibernations_user_app_key" UNIQUE ("user_id", "app_key"),
    CONSTRAINT "app_sandbox_hibernations_object_key_key" UNIQUE ("object_key"),
    CONSTRAINT "app_sandbox_hibernations_secrets_object_key_key" UNIQUE ("secrets_object_key"),
    CONSTRAINT "app_sandbox_hibernations_app_key_check"
        CHECK ("app_key" ~ '^[a-z][a-z0-9-]{1,38}[a-z0-9]$'),
    CONSTRAINT "app_sandbox_hibernations_sha256_check" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "app_sandbox_hibernations_bytes_check" CHECK ("bytes" > 0),
    CONSTRAINT "app_sandbox_hibernations_reason_check"
        CHECK ("reason" IS NULL OR "reason" IN ('cap', 'retention', 'user')),
    CONSTRAINT "app_sandbox_hibernations_secrets_check" CHECK (
        ("secrets_object_key" IS NULL AND "secrets_sha256" IS NULL
            AND "secrets_bytes" IS NULL AND "secrets_wrapped_key" IS NULL)
        OR ("secrets_object_key" IS NOT NULL AND "secrets_sha256" ~ '^[0-9a-f]{64}$'
            AND "secrets_bytes" > 0 AND "secrets_wrapped_key" IS NOT NULL)
    )
);
