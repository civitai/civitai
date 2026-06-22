-- First-party spoke DOMAIN registry for the OAuth cross-domain login flow (replaces AUTH_SPOKE_ORIGINS).
-- The hub authorizes a login host against these rows (exact `domain`, or any subdomain when
-- `includeSubdomains`). Applied MANUALLY (this repo does not use `prisma migrate deploy`), so the DDL is
-- idempotent — re-running it on a DB where the table already exists is a no-op rather than an error.
CREATE TABLE IF NOT EXISTS "TrustedSpokeDomain" (
    "id" SERIAL NOT NULL,
    "domain" TEXT NOT NULL,
    "includeSubdomains" BOOLEAN NOT NULL DEFAULT false,
    "label" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TrustedSpokeDomain_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "TrustedSpokeDomain_domain_key" ON "TrustedSpokeDomain"("domain");

-- Baseline seed (prod hosts). Idempotent — does NOT clobber rows added per-environment (e.g. the
-- `civitaic.com` preview wildcard, `localhost`, or `test-auth.*` aliases).
INSERT INTO "TrustedSpokeDomain" ("domain", "includeSubdomains", "label") VALUES
  ('civitai.com', false, 'green (prod)'),
  ('civitai.red', false, 'red (prod)')
ON CONFLICT ("domain") DO NOTHING;
