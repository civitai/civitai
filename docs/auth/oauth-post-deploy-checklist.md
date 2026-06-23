# OAuth-first-party migration — post-deploy checklist

**Scope:** what to verify + do **right after** the auth-hub / OAuth-first-party cutover goes live. This is the
*verification + watch + cleanup* list — the *pre-deploy* env/infra setup lives in
[auth-hub-launch-checklist.md](auth-hub-launch-checklist.md), the deferred hardening in
[oauth-security-review-2026-06-22.md](oauth-security-review-2026-06-22.md), and the `NEXT_PUBLIC_BASE_URL`
cleanup in [post-deploy-domain-env-consolidation.md](post-deploy-domain-env-consolidation.md).

Legend: 🛠️ devops/config · 🧪 smoke test · 👁️ monitor · 🧹 cleanup · ⏭️ deferred follow-up.

---

## Phase 1 — Config sanity (first 15 min, before announcing)

- [x] 🛠️ **`NEXTAUTH_SECRET` is IDENTICAL on the hub and the main app.** It's the shared salt for hashing
  every API key + OAuth token (`SHA512(token + NEXTAUTH_SECRET)`), so a mismatch silently breaks ALL token
  auth (validation just returns 401, no error). Confirm by comparing a fingerprint (`SHA256(secret)[:8]`) on
  both. (This is review finding **H2** — not legacy-only.)
- [x] 🛠️ **`AUTH_JWT_ISSUER` / `AUTH_JWKS_URI` point at the hub** (`https://auth.civitai.com`) on the main
  app + every spoke, and the hub can actually be reached from each app's server context (the spoke does a
  server-side JWKS + identity fetch). A wrong/unreachable value degrades sessions to anonymous (fails open),
  not a 500.
- [x] 🛠️ **`AUTH_ADMIN_USER_IDS` is set on the hub** (comma-separated, e.g. `1,5`). It's **fail-closed** —
  unset = `/admin` (the TrustedSpokeDomain editor) is locked for everyone.
- [ ] 🛠️ **`AUTH_INTERNAL_TOKEN` is IDENTICAL on the hub and the main app.** Besides cache-invalidation it
  now also gates the new **legacy-exchange** upgrade-on-read endpoint (`POST /api/auth/oauth/legacy-exchange`).
  Missing/mismatched is **not** a hard break — the main app silently skips the upgrade and legacy users keep
  working via the read-only legacy decode — but legacy cookies then won't actively migrate to civ-token.
- [x] 🛠️ **`AUTH_JWT_AUDIENCE` is UNSET everywhere** (esp. on consumers like `advertising.civitai.com`). The
  hub emits no `aud`; if a consumer sets it, jose rejects every hub token.
- [x] 🛠️ **`AUTH_COOKIE_DOMAIN`** is correct per env (prod hub `.civitai.com`; a single-color/preview env its
  own parent). The hub default self-derives from its own host, so a `civitaic.com` staging hub works without
  override.
- [x] 🛠️ **Dead env vars removed** from deploy secrets/manifests: `AUTH_SPOKE_ORIGINS`, `AUTH_SWAP_MAX_AGE`
  (and any lingering `AUTH_JWT_AUDIENCE`, `AUTH_SESSION_COOKIE`). Harmless to leave (ignored), but clean them.

## Phase 1b — Database

- [x] 🛠️ **`TrustedSpokeDomain` table created + seeded** — *already live in prod* (verified 2026-06-23): rows
  `civitai.com`/`civitai.red` (exact), `civitaic.com` (wildcard), `localhost`, `test-auth.civitai.{com,red}`.
  Migrations are applied **manually** (no `prisma migrate deploy`). If deploying to a fresh env, apply
  `20260622180000_add_trusted_spoke_domain` (CREATE TABLE is idempotent) + seed the env's login hosts.
- [x] 🛠️ When enabling a **new login host**, add **one row** to `TrustedSpokeDomain` (via the hub `/admin`
  UI). Keep `includeSubdomains` to **`civitaic.com` only** (review **M4**).

## Phase 2 — First-party login smoke tests (per color/domain)

- [ ] 🧪 **Login on each served host** — `civitai.com`, `civitai.red`, and any test alias (`test-auth.*`).
  Confirm you land back on the spoke authenticated (not bounced to the hub root).
- [ ] 🧪 **The `civ-token` cookie actually STICKS** on each host (open devtools → it's present + `__Secure-`
  in prod). A cookie that doesn't stick = the cross-domain misconfig the suffix-guard + loop-breaker guard
  against. If you hit the terminal "We couldn't sign you in" page, the cookie's `Domain`/`Secure` is wrong
  for that host — check `cookieDomainForHost` / `AUTH_COOKIE_DOMAIN`.
- [ ] 🧪 **Add-account / account switch** (the device-set flow).
- [ ] 🧪 **Cross-site shared device set** — log in on `civitai.com`, then open `civitai.red` (it auto-SSOs via
  the bridge). Confirm BOTH hosts carry the **same `civ-device` value** (devtools → Application → Cookies) and
  the account switcher shows the **identical account set** on each. A `.red` `civ-token` present but a missing
  or *different* `civ-device` means the bridge isn't propagating the hub's shared device id — the
  authorize→callback→`/session` path stashes it at `/authorize` and returns it from `/session`
  (`setSessionCookie(..., { deviceCookie })`). Verify the reverse too (sign in first on `.red`).
- [ ] 🧪 **Moderator impersonate → then EXIT impersonation** (the browser-client exit path — recently fixed to
  `POST /api/auth/impersonate/exit`).
- [ ] 🧪 **Connected accounts** (`/user/account`): link + unlink each provider (Discord/Google/GitHub/Reddit)
  — routes through the hub's `?link=true` flow.
- [ ] 🧪 **Discord Linked-Roles** (`/discord/link-role`): connect, then confirm roles actually sync. ⚠️
  **Known gap:** the hub stores the granted *scope* but not the Discord `access_token`/`refresh_token` on the
  `Account` row, so the role-metadata push may silently fail (the page still shows success). Verify; if
  broken, it's the hub-token-persistence follow-up.
- [ ] 🧪 **Same-site spokes** (`moderator.civitai.com`, `advertising.civitai.com`): they read the shared
  `.civitai.com` cookie directly. Confirm they see the session after a hub login.

## Phase 3 — Third-party OAuth

- [ ] 🧪 **Existing access tokens still work** — call `/api/v1/me` with a known production token (hash is
  backward-compatible, so this should just work as long as `NEXTAUTH_SECRET` wasn't rotated).
- [ ] 🧪 **Legacy endpoint forwarding** — `curl -i https://civitai.com/api/auth/oauth/token` (and `/authorize`,
  `/userinfo`, `/revoke`, `/device`) 308-redirects to the hub.
- [ ] 🧪 **Legacy OIDC discovery + JWKS forward** — `curl -i https://civitai.com/.well-known/openid-configuration`
  and `https://civitai.com/api/auth/jwks` 308 to the hub. **Confirm the edge maps the public root
  `/.well-known/openid-configuration` → the `/api/.well-known/...` route** (it's not in `next.config`; it's an
  edge rule, same as pre-migration). If it 404s, the edge mapping needs restoring.
- [ ] 🧪 **Full third-party flow on the hub** — authorize (consent shown) → token → `/api/v1` with the Bearer.
- [ ] ⏭️ **Notify any legacy OIDC RP pinned to the `civitai.com` issuer** to switch to `auth.civitai.com`
  (forwarding fixes transport, not the `iss` identity — see the dev-docs note). Likely a *handful at most*;
  handle reactively if a login-broke ticket appears.

## Phase 4 — Monitor (first 24–48h)

- [ ] 👁️ **401 spike on `/api/v1`** → would indicate a token-hash/secret mismatch (H2). Should be flat.
- [ ] 👁️ **Redirect loops / the loop-breaker terminal page** (the `civ_postlogin` marker path) → a
  cross-domain cookie misconfig on some host.
- [ ] 👁️ **`invalid_client` on `/session`** → a first-party login host missing from `TrustedSpokeDomain`.
- [ ] 👁️ **Hub-unreachable from spokes** (JWKS/identity fetch failures) → sessions silently dropping to
  anonymous.
- [ ] 👁️ **`fetch failed` 500s on search endpoints** (`/api/v1/images`, `/api/v1/models`) → this is the
  **search backend** (`SEARCH_HOST`/`FEED_IMAGE_HOST`), *not* auth — verify search reachability per env.
- [ ] 👁️ **Legacy-cookie migration is happening** → the count of requests still authenticating via the legacy
  cookie should TREND DOWN as upgrade-on-read swaps each one for a civ-token on first page load. A flat
  legacy count = the exchange is failing (check `AUTH_INTERNAL_TOKEN` parity + hub reachability); legacy auth
  still works regardless (read-only decode), it just isn't migrating.

## Phase 5 — Cleanup

- [ ] 🧹 **Delete the junk/probe OAuth clients** with apex-Civitai redirect URIs (`"1"`, `"df"`, `"tttt"`,
  `"Civitai"`, `"IDM"` — see the OauthClient review). Eyeball in Retool first.
- [ ] 🧹 **Sunset the legacy forwarders** (`/api/auth/oauth/[...path]`, the discovery/JWKS forwarders) once
  legacy clients have re-pointed at the hub.
- [ ] 🧹 **Drop the whole legacy-cookie path together once old cookies have aged out** (≥30d past cutover, when
  the legacy-auth count from Phase 4 hits ~zero): the hub `legacy-exchange` route + `legacy-cookie.ts` decode,
  the main app's `getLegacySession` / `maybeUpgradeLegacySession`, and the `clearLegacy*` cookie helpers.
- [x] 🧹 **Deleted the dead `civ-token` AES endpoint** (`src/server/auth/civ-token.ts` +
  `src/pages/api/auth/civ-token.ts`) — caller-less legacy swap helper. Kept `civToken.schema.ts`
  (`EncryptedDataSchema` is still type-referenced by `AccountProvider.tsx`). `NEXTAUTH_SECRET` stays — it's the
  active token-hash salt, not legacy-only (see H2).

## Auth-authority consolidation (post-release architectural follow-ups)

From the main-app audit — the same class as the dropped `getSessionUser` (auth-authority work the hub should
own, currently in the main app). All **work today** (shared DB), so these are *relocations for ownership
clarity*, not correctness fixes. Each mixes hub-authority writes with main-app side-effects (orchestrator cache
busts, analytics), so the pattern is "move the write behind a hub endpoint; keep/emit the side-effect."

- [ ] ⏭️ **OAuth client management → hub.** `src/server/routers/oauth-client.router.ts`
  `create`/`update`/`rotateSecret`/`delete` write the shared `OauthClient` table (generate + hash client
  secrets, cascade-revoke tokens) — and the hub has **no** client-management endpoints. The hub is the OAuth
  provider; its client registry is provider authority. Reads (`getAll`/`getById`) + `OAuthAppsCard` UI stay.
- [ ] ⏭️ **OAuth consent lifecycle → hub.** `oauth-consent.router.ts` `revokeApp` (deletes a user's tokens +
  `OauthConsent` row) is grant-revocation authority. `setBuzzLimit` writes the hub-owned `OauthConsent` row — a
  *buzz* concern living on hub state (layering smell either way).
- [ ] ⏭️ **`VerificationToken` cleanup → hub.** `src/server/jobs/next-auth-cleanup.ts` cron deletes expired
  `verificationToken` rows — a table the **hub** now owns (it creates them for email-login). Move the sweep to
  the hub (or delete if the hub adds its own). Minor: its `deleteMany` is also not `await`ed.

## Deferred hardening (post-deploy, not blockers — see oauth-security-review-2026-06-22.md)

- [ ] ⏭️ **H1 belt-and-suspenders:** reject `redirect_uri`/`allowedOrigin` under an owned/trusted domain at
  client registration (the identity-gating fix already shipped closes the hole; this prevents the junk-client
  pattern at the source).
- [ ] ⏭️ **H2:** split the token-hash salt off `NEXTAUTH_SECRET` (dedicated `API_KEY_HASH_SECRET`) so the
  legacy secret can finally sunset; give Forgejo (`dev-git-access`) its own key.
- [ ] ⏭️ **M2:** refresh-token reuse detection (family-cascade) for public PKCE clients.
- [ ] ⏭️ **Orchestrator cache-bust on `/revoke`** (main added `invalidateCivitaiUser` on token revoke; the
  hub `/revoke` has no equivalent yet).
- [ ] ⏭️ **Discord Linked-Roles token persistence** (Phase-2 gap above): persist the Discord
  `access_token`/`refresh_token`/`expires_at` on link so role-metadata sync works.
