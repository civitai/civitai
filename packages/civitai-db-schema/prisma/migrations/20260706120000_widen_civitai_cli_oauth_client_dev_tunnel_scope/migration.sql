-- Widen the first-party `civitai-cli` OAuth client's allowedScopes to permit the
-- new opt-in `TokenScope.AppBlocksDevTunnel` bit, so the OAuth `civitai login`
-- token can open on-site App Block dev tunnels (blocks.router: startDevTunnel /
-- stopDevTunnel / devTunnelStatus). Prior to this the CLI token carried only
-- `UserRead | AppBlocksSubmit`, so those procedures (now gated on the DevTunnel
-- bit) rejected it and users had to fall back to a Full-scope personal API key.
--
-- allowedScopes: 33554433 -> 100663297
--   old = TokenScope.UserRead | TokenScope.AppBlocksSubmit
--       = 1 | 33554432
--       = 33554433
--   new = old | TokenScope.AppBlocksDevTunnel
--       = 33554433 | (1<<26)
--       = 33554433 | 67108864
--       = 100663297
-- (AppBlocksDevTunnel, bit 26 = 1<<26 = 67108864, is opt-in and INTENTIONALLY
--  excluded from TokenScope.Full = 33554431 — like AppBlocksSubmit. This client is
--  the only first-party consumer that requests it.)
--
-- IDEMPOTENT: the OR-in of the bit is a no-op on re-apply (re-ORing the same bit
-- leaves the value unchanged); scoped to the single `civitai-cli` row so it can
-- never touch another client's grant.
--
-- 🔴 DEPLOY ORDERING: apply this migration (and merge/deploy the server change
-- that gates the dev-tunnel procs on AppBlocksDevTunnel) BEFORE releasing a
-- civitai CLI that REQUESTS the wider scope. If the CLI requests the bit before
-- this widens allowedScopes, the hub's per-client allowedScopes intersection
-- rejects the device request with `invalid_scope` and `civitai login` 400s.
--
-- ⚠️ MANUAL-APPLY: per the cluster ops rule, civitai DB migrations are NOT
-- auto-applied. A human applies this to prod (CNPG nvme0) and the dev clone.
UPDATE "OauthClient"
SET "allowedScopes" = "allowedScopes" | 67108864, -- TokenScope.AppBlocksDevTunnel (1<<26)
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'civitai-cli'
  AND ("allowedScopes" & 67108864) = 0; -- no-op once the bit is already set
