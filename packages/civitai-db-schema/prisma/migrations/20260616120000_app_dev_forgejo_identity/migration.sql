-- App Blocks Phase 3 (git-push self-service): per-civitai-user Forgejo identity.
--
-- Lazily provisioned the first time a developer requests git access to one of
-- their apps. The Forgejo user is `restricted:true` and granted `write` ONLY on
-- its own civitai-apps/<slug> repo(s) — a push parks a pending review request
-- but can NEVER deploy without mod approval (no-trust-on-push gate unchanged).
--
-- 1:1 with User (the PK IS the civitai userId). `forgejo_token_encrypted` holds
-- the user's own Forgejo PAT (sha1, scope `write:repository`), AES-256-GCM
-- encrypted at rest. It is the SOURCE OF TRUTH for the token because Forgejo
-- cannot recover a user's password to re-mint: the token is minted once at
-- provision and re-read thereafter.
--
-- Additive → backward-compatible, safe to apply ahead of the rollout. civitai
-- applies migrations MANUALLY (no `prisma migrate deploy`) — apply to prod
-- cnpg-nvme0 AND the cnpg-cluster-dev clone.

CREATE TABLE IF NOT EXISTS "app_dev_forgejo_identity" (
    "user_id" INTEGER NOT NULL,
    "forgejo_username" TEXT NOT NULL,
    "forgejo_token_encrypted" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_dev_forgejo_identity_pkey" PRIMARY KEY ("user_id")
);

-- FK to User: a GDPR delete cascades the developer's Forgejo identity away.
ALTER TABLE "app_dev_forgejo_identity"
  ADD CONSTRAINT "app_dev_forgejo_identity_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
