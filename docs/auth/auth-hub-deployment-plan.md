# Auth Hub — Deployment Plan & Runbook

**Status:** current · **Last updated:** 2026-06-25 · **Owner:** briant@civitai.com

The single, consolidated deployment runbook for the **first-party OAuth / auth-hub** cutover
(`feat/oauth-first-party`, merged to `main` via #2468). It ties together the architecture spec and
the per-phase checklists into one ordered procedure. It does **not** restate them — read alongside:

| Canonical doc | Use it for |
|---|---|
| [`auth-hub-spoke-overview.md`](./auth-hub-spoke-overview.md) | **Current architecture** (hub = issuer, spokes verify locally) |
| [`oauth-post-deploy-checklist.md`](./oauth-post-deploy-checklist.md) | The detailed per-host smoke matrix (Phases 1–5) |
| [`auth-hub-launch-checklist.md`](./auth-hub-launch-checklist.md) | Infra/env line items |
| [`oauth-developer-docs.md`](./oauth-developer-docs.md) | Third-party OAuth client contract |

> **Doc-staleness warning.** `oauth-migration-handoff.md`, `auth-prelaunch-action-checklist.md`,
> `main-app-auth-cutover.md`, `oauth-first-party-migration-plan.md`, and `centralized-auth-app.md`
> describe the **superseded** swap-token-bridge / `USE_HUB_SESSION` design. The swap bridge and that
> flag are deleted; cross-domain login now runs on **OAuth authorization-code + PKCE**. Where they
> disagree with this doc, this doc wins.

---

## 1. What ships

| Artifact | Source | Build & deploy path |
|---|---|---|
| **Login hub** — `auth.civitai.com` (the sole session **issuer**) | `apps/auth` (SvelteKit + `adapter-node`) | **GitHub Actions → ghcr → Flux.** [`.github/workflows/auth-app.yml`](../../.github/workflows/auth-app.yml) builds `apps/auth/Dockerfile` (context = repo root) → `ghcr.io/civitai/civitai-auth:<semver>` (+ `:sha-<short>`). Triggered by pushing a **`auth-app-v*`** tag (e.g. `auth-app-v0.1.0`). PRs build-only. **No `:latest`.** Flux in `datapacket-talos` has a semver `ImagePolicy` + `ImageUpdateAutomation` on that repo → rolls out. |
| **Main app (spoke)** — `civitai.com` + `civitai.red` | `src/` (NextAuth fully removed; new spoke `/api/auth/authorize` + `/api/auth/callback` bridge, `oauth-bridge.ts`, `session-client.ts`, legacy upgrade-on-read) | **Tekton** (`tekton.civitai.com`) builds `civitai-web` — **unchanged**. The hub is the *only* app on ghcr+Flux; the main app stays on Tekton. |
| **Moderator app (spoke)** — `moderator.civitai.com` | `apps/moderator` (verify-only, same-site `.civitai.com`, gates on `isModerator`) | **POC — no Dockerfile, no CI workflow in-repo yet.** Reads the shared `.civitai.com` cookie directly; needs no login UI, no bridge endpoints, no `TrustedSpokeDomain` row. Not part of this cutover. |

**Build dependency note.** `@civitai/auth` (`packages/civitai-auth`) is a `workspace:*` dependency of
**all three** apps. A change to it cascades to the hub, the main app, **and** moderator — so any future
change there means rebuilding more than just `apps/auth`. See §7 for graph-aware CI detection.

---

## 2. Database prerequisite (apply manually, before the hub serves)

We do **not** use `prisma migrate deploy` — migrations are applied by hand (psql/Retool). The only
net-new table this cutover **requires** is **`TrustedSpokeDomain`**:

- File: [`packages/civitai-db-schema/prisma/migrations/20260622180000_add_trusted_spoke_domain/migration.sql`](../../packages/civitai-db-schema/prisma/migrations/20260622180000_add_trusted_spoke_domain/migration.sql)
- Replaces the retired `AUTH_SPOKE_ORIGINS` env allowlist. The hub authorizes a cross-domain login
  host against these rows (exact `domain`, or any subdomain when `includeSubdomains`).
- **Idempotent** (`CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`) and **self-seeds**
  `civitai.com` + `civitai.red` (exact) via `ON CONFLICT DO NOTHING`. Re-running is a no-op.
  - ⚠️ `oauth-migration-handoff.md` claims the table "ships empty" — **stale**; the committed migration
    includes the baseline seed.
- **Prod is already applied & seeded** (verified 2026-06-23, per `oauth-post-deploy-checklist.md`):
  `civitai.com`/`civitai.red` (exact), `civitaic.com` (**`includeSubdomains=true`**, for `pr-NNNN.civitaic.com`
  previews), `localhost`, `test-auth.civitai.{com,red}`. **For a fresh env, apply the SQL then add the
  env's served hosts** via the hub `/admin` UI. Keep `includeSubdomains=true` for `civitaic.com` only.
- Cache: ~60s in-memory; DB error → serves last-good list; cold-start empty = **fail-closed** (first-party
  login denied until a row exists).

Other OAuth-provider migrations in the merge window (`OauthClient`, `OauthConsent`, `ApiKey.clientId`,
token-scope, allowed-origins) predate this branch and are **already in prod**. Nothing else net-new is
required before the hub serves.

---

## 3. Environment variables

Spoke verify vars are read by `@civitai/auth`'s own lazy zod schema (`loadAuthEnv()`,
`packages/civitai-auth/src/env.ts`), **not** the main app's `src/env/server-schema.ts`. Full annotated
contract: [`apps/auth/.env.example`](../../apps/auth/.env.example). Deployment-critical subset:

| Var | Hub | Main | Mod | Purpose / gotcha |
|---|:--:|:--:|:--:|---|
| `AUTH_JWT_PRIVATE_KEY` | ✅ | — | — | PKCS8 PEM, **EC P-256 only** (RSA throws at boot). Signs `civ-token` (ES256). Never leaves the hub. |
| `AUTH_JWT_PUBLIC_KEY` | ✅ | opt | — | SPKI PEM; served at JWKS. If set on a spoke → local verify (skip JWKS fetch). |
| `AUTH_JWT_KID` | ✅ | — | — | **Must not change during cutover** — changing `kid` (or the cookie name) logs everyone out. |
| `AUTH_JWT_ISSUER` | ✅ | ✅ | ✅ | `https://auth.civitai.com`. JWT `iss`, hub origin every spoke targets, **and** the cookie `__Secure-`/Domain fallback. Empty → cookie loses its prefix + Domain → redirect loop (see §5). |
| `AUTH_JWKS_URI` | ✅ | ✅ | ✅ | `https://auth.civitai.com/api/auth/jwks` — spoke verify key source. |
| `AUTH_INTERNAL_TOKEN` | ✅ | ✅ | opt | Service secret for `POST /api/auth/identity` (cache bust) + legacy upgrade-on-read. **Identical hub↔main.** Mismatch = legacy→civ-token migration silently skipped (soft gate). |
| `NEXTAUTH_SECRET` | ✅ | ✅ | — | Salt for **all active** API-key/OAuth-token hashing + email-token hash + legacy JWE decode. **Identical hub↔main** or all token auth 401s. |
| `AUTH_COOKIE_DOMAIN` | ✅ | ✅ | — | Prod = `.civitai.com`; localhost = empty (host-only). |
| `AUTH_ADMIN_USER_IDS` | ✅ | — | — | Comma list; `/admin` (TrustedSpokeDomain editor). **Fail-closed** (unset = locked). |
| `AUTH_CORS_ORIGINS` | ✅ | — | — | Same-site `*.civitai.com` browser-client allowlist. (Cross-site login origins live in the DB table, not here.) |
| `ORIGIN`, `ADDRESS_HEADER`, `XFF_DEPTH` | ✅ | — | — | adapter-node behind ingress. `ORIGIN` drives redirect_uri + email links + CSRF; the others give the real client IP for rate-limit/Turnstile. |
| providers, `EMAIL_*`, `CF_MANAGED_TURNSTILE_*`, `DATABASE_URL`, `REDIS_URL`, `REDIS_SYS_URL`, `TIER_METADATA_KEY`, `AUTH_DEFAULT_RETURN_URL`, `CLICKHOUSE_TRACKER_URL` | ✅ | (shared) | — | See `.env.example`. Hub needs its **own** copy of Turnstile + provider creds (env is per-deploy). |

**Must be UNSET everywhere:** `AUTH_JWT_AUDIENCE` (hub emits no `aud`; setting it makes jose reject
every hub token). **Retire from manifests:** `AUTH_SPOKE_ORIGINS`, `AUTH_SWAP_MAX_AGE`,
`AUTH_SESSION_COOKIE`, `NEXT_PUBLIC_AUTH_HUB_URL`. `NEXTAUTH_URL` / `NEXTAUTH_COOKIE_DOMAIN` retire once
legacy cookies age out.

---

## 4. Deployment runbook (ordered)

> Each step is a go/no-go gate. Stop and resolve before proceeding.

### Pre-flight (before announcing)
- [ ] **Secret parity.** `NEXTAUTH_SECRET` and `AUTH_INTERNAL_TOKEN` are **byte-identical** hub↔main.
      Verify without printing the secret: compare `SHA256(secret)[:8]` fingerprints on both.
- [ ] **Issuer/JWKS reachable** from each spoke's **server** context: `AUTH_JWT_ISSUER` and
      `AUTH_JWKS_URI` resolve and return the JWKS.
- [ ] `AUTH_JWT_AUDIENCE` is **unset** on hub and every spoke.
- [ ] `AUTH_COOKIE_DOMAIN` correct per env (`.civitai.com` in prod), `AUTH_ADMIN_USER_IDS` set,
      `AUTH_JWT_KID` matches the key being shipped.
- [ ] **DB:** `TrustedSpokeDomain` exists and has rows for every host this env serves (§2).

### Ship the hub
- [ ] Tag the release: `git tag auth-app-v<X.Y.Z> && git push origin auth-app-v<X.Y.Z>`.
- [ ] Confirm the Action pushed `ghcr.io/civitai/civitai-auth:<X.Y.Z>` and Flux rolled it out.
- [ ] **Hub health:** `GET https://auth.civitai.com/api/health` → `200 {status:'ok'}`.

### Ship the spokes
- [ ] Deploy the main app (Tekton) with the spoke env above. `.red` and the main app run
      `produceFallback` (hub-independent local session production) — keep it on for now.
- [ ] (Moderator app is POC; not deployed here.)

### Verify (see §6), then monitor 24–48h, then clean up (§3 retire-list).

---

## 5. Cutover hazards & go/no-go gates

- **Stale host-only cookie shadow** *(the load-bearing hazard).* An old **host-only** cookie of the same
  name shadows the new `.civitai.com` cookie → login redirect loop, or a terminal "We couldn't sign you
  in" page. The hub clears legacy `.civitai.com` next-auth cookies on logout. **Hardening already in `main`**
  (commit `2592d6102`): hub logout now clears the legacy **and** hub session/device cookies **both
  host-only and Domain-scoped** (`apps/auth/src/lib/server/auth/legacy-cookies.ts`, `cookie`/`device.ts`) —
  a Domain-scoped delete alone cannot evict a host-only twin. Still: **if you see a redirect loop on a
  specific host, delete the host-only cookie variant for that host.**
- **Cookie doesn't stick / `__Secure-` lost.** Root cause: `isSecureCookie()`
  (`packages/civitai-auth/src/cookies.ts`) derives from `NEXT_PUBLIC_BASE_URL || AUTH_JWT_ISSUER`; if both
  are empty the cookie drops its `__Secure-` prefix + `.civitai.com` Domain. **Ensure `AUTH_JWT_ISSUER` is
  set on the hub** (pre-flight covers it).
- **Never change cookie `name` or signing `kid`** during the window — that invariant is what keeps existing
  sessions alive.
- **Single-logout / revocation.** Hub tracks each token by `jti`; logout/ban → `TOKEN_STATE[jti]='invalid'`
  → spokes reject via injected `isRevoked`. Logout is **POST-only** (CSRF). The cross-domain single-logout
  landing page is merged (`93ceb7d50`, `44fe44062`).
- **Fail-open vs fail-closed.** Wrong/unreachable issuer/JWKS degrades sessions to **anonymous** (not 500).
  `AUTH_ADMIN_USER_IDS` and `TrustedSpokeDomain` cold-start are **fail-closed**.

---

## 6. Verification / smoke (post-deploy)

Full matrix in [`oauth-post-deploy-checklist.md`](./oauth-post-deploy-checklist.md). Minimum bar:

- **Per host** (`civitai.com`, `civitai.red`, `test-auth.*`): login lands back authenticated; `civ-token`
  sticks (`__Secure-` in prod); add-account / switch; cross-site **shared device set** (same `civ-device`
  + identical account list on `.com` and `.red`); moderator **impersonate + exit**; connected-accounts
  link/unlink; Discord linked-roles; same-site spokes see the session.
- **Third-party OAuth:** a known prod token still authenticates `GET /api/v1/me` (hash is backward-compatible);
  legacy forwarders 308-redirect to the hub (`/api/auth/oauth/{token,authorize,userinfo,revoke,device}`,
  `/.well-known/openid-configuration`, `/api/auth/jwks`); a full authorize→token→Bearer flow on the hub.
  Device-flow token poll mints exactly one token pair (the redemption race was closed in `2592d6102`).
- **Monitor 24–48h:** flat `401` rate on `/api/v1` (a spike = secret mismatch); no redirect loops; no
  `invalid_client` on `/session` (= a host missing from `TrustedSpokeDomain`); legacy-cookie auth count
  **trending down** (else upgrade-on-read is failing — check `AUTH_INTERNAL_TOKEN` parity).
- **Suites:** `@civitai/auth` vitest, hub vitest (incl. OAuth parity + `ban-session-revocation`), main-app
  `tsc`. Cross-site cookie e2e (`apps/auth/e2e/hub-login.spec.ts`, `tests/preview-auth-guard.spec.ts`) needs
  a deployed preview/hub harness — can't run on localhost.

---

## 7. CI: deploy only what changed (graph-aware)

The `auth-app.yml` PR gate triggers on `apps/auth/**` **or** `packages/**` — deliberately coarse
(over-triggers, never misses). The hub, though, only depends on **6 of the 9** workspace packages
(`auth`, `brand`, `db`, `db-schema`, `email`, `redis` — **not** `axiom`, `clickhouse`, `telemetry`), so a
PR touching only an unconsumed package rebuilds the image for nothing. A graph-aware gate trims that, and
also future-proofs the broader "rebuild the hub? the main app? both?" decision — because `@civitai/auth`
feeds all three apps, a change there must redeploy more than just `apps/auth`. Use **turbo's affected
detection**, which reads the `workspace:*` edges.

**Implemented** in [`auth-app.yml`](../../.github/workflows/auth-app.yml): an `affected` job runs before
`build` and sets `hub_affected`. The `build` job gates on it (`if: needs.affected.outputs.hub_affected ==
'true'`); a job skipped via job-level `if` counts as **success** for branch-protection required checks, so
skipping a non-hub PR won't block merges. Tag releases and `workflow_dispatch` always set it `true` —
affected-detection only trims the PR compile gate, it never gates a real deploy.

The detection query (verified on turbo 2.9.18):

```bash
# Hub must rebuild iff @civitai/auth-app is in its OWN affected closure since <base>:
pnpm dlx turbo@2.9.18 run build --filter="@civitai/auth-app...[<base>]" --dry=json \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(new Set(j.tasks.map(t=>t.package)).has('@civitai/auth-app'))})"
# true when a hub dependency (e.g. civitai-redis) or the lockfile changed; false for axiom/clickhouse/telemetry.
```

> ⚠️ Use the **app-scoped** form `@civitai/auth-app...[<base>]`, **not** the bare reverse-dependents form
> `...[<base>]`. In turbo 2.9 the latter (and `turbo ls --filter="...<pkg>"`) is unreliable — it dropped
> `@civitai/auth-app` from the set even when a dependency changed. Scope to the app and check membership.

In CI, key the base off the PR base SHA (`pull_request.base.sha`) or the **last-deployed SHA per app**
(not `HEAD~1`, which a squash-merge would under-trigger), and **`fetch-depth: 0`** — a shallow clone makes
turbo treat everything as affected. Direct-path safety nets (`apps/auth/**`, `patches/**`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, the workflow file) force a build regardless. This is an **operational improvement**,
not a cutover blocker.

---

## 8. Rollback (⚠️ open item)

There is **no single end-to-end rollback runbook** — `auth-prelaunch-action-checklist.md` §3 flags this as
an open action. The de-facto story:

- **Sessions survive a hub outage.** Spokes verify locally (ES256 + cache → `produceFallback` local DB
  production), so existing `civ-token` holders stay logged in if the hub is down; only **new logins** need
  the hub (mitigate with hub HA). `produceFallback` is **temporary** — revert once the hub is proven stable.
- **Hub image rollback:** pin Flux back to a prior `ghcr.io/civitai/civitai-auth:<semver>` (it selects by
  semver `ImagePolicy`).
- **No flag-flip back to NextAuth:** once a user holds a `civ-token`, reverting to NextAuth would ignore that
  cookie and log them out (and they couldn't re-login if the hub is what failed) — which is why NextAuth was
  deleted rather than kept behind a flag. Phases 1–4 were additive (no data migration), so the practical
  "stop" is to quit routing logins to `/authorize`.

**Action before the next env's cutover:** write the explicit rollback runbook (image pin + DNS/route revert
+ `produceFallback` confirmation steps) and link it here.
