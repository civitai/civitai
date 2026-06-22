# Adding Auth to a Spoke App — Integration Plan

**Status:** design / proposal (2026-06-22). Reference implementation: the main app (`civitai.com`). Companion
to [auth-hub-spoke-overview.md](./auth-hub-spoke-overview.md).

**Audience:** anyone standing up a new app in the monorepo that needs to authenticate users against the hub
(`auth.civitai.com`) — e.g. `moderator.civitai.com`, `test-auth.civitai.red`, a new SvelteKit/Next spoke.

The goal of this doc: enumerate **exactly which API endpoints a spoke must expose, which hub endpoints it
calls, and how it validates/fetches session data** — so adding a new app is a known, finite checklist and not
a re-derivation each time.

---

## 1. Mental model

- **The hub is the sole authority.** It is the only minter of session tokens (`civ-token`, thin ES256) and the
  sole producer of rich `SessionUser` data. Spokes never mint and never compute a user from the DB.
- **A spoke owns its own cookie.** A spoke on a different registrable domain (`civitai.red`) can't read the
  hub's `.civitai.com` cookie, so each spoke runs the OAuth authorization-code + PKCE flow against the hub and
  sets **its own** `civ-token` cookie on its own domain. Same family domain or cross-site — identical flow.
- **Two trust tiers of client.** The hub treats *first-party* (trusted) spokes specially: they skip the consent
  screen and are the only clients allowed to exchange a code for a **session** (not just an API token). A host
  becomes first-party by being in the hub's `TrustedSpokeDomain` registry (see §6).

```
Browser ──(top-level nav)──▶ Spoke /api/auth/authorize ──302──▶ Hub /api/auth/oauth/authorize
                                                                          │ (login if needed, consent skipped)
Browser ◀────────────────── Spoke /api/auth/callback ◀──302 (?code)──────┘
   │  (server-to-server)
   └─ Spoke ──POST code+verifier──▶ Hub /api/auth/oauth/session ──civ-token──▶ Spoke sets cookie ─▶ dest
```

---

## 2. Why most of this is server-to-server (the key constraint)

Most `@civitai/auth` methods call the hub **from the spoke's server**, not the browser. Two reasons, and they
drive the whole endpoint shape:

1. **Credentialed cross-origin cookie-setting doesn't work cross-site.** The hub's `Set-Cookie` can't be
   applied to a `civitai.red` browser context from an `auth.civitai.com` response. So for any operation that
   must change the spoke's cookie (login, switch, impersonate, refresh), the **browser hits the spoke's own
   origin**, the spoke forwards the request to the hub server-to-server, then the spoke re-sets the cookie on
   its own response. These are the "same-origin proxy" endpoints (§4, group C).
2. **Service-authed writes carry a secret.** Cache invalidation targets an arbitrary `userId` (a mod banning
   someone, a webhook), so it's authed by the shared `AUTH_INTERNAL_TOKEN` — which must never reach a browser.

Steady-state session **reads** are the exception: they verify the token **locally** (hub JWKS, cached) with no
hub hop — see §5.

---

## 3. Tiers — only build what the app needs

| Tier | Capability | Spoke endpoints (group in §4) |
|------|-----------|-------------------------------|
| **T0 Read-only** | Consume an existing session (verify + fetch user). No login UI. | B (`/session`) only |
| **T1 Login** | Cross-domain login + logout | A (`/authorize`, `/callback`), B (`/session`), D (`/logout`) |
| **T2 Multi-account** | Account switcher | + C (`/switch`, `/accounts`) |
| **T3 Moderation** | Impersonation | + `/impersonate` |

A T0 spoke on a subdomain of an already-logged-in family domain may not even need its own login (it can share
the cookie); a spoke on a **different registrable domain always needs T1** to mint its own cookie.

---

## 4. Endpoints the spoke must expose (browser-facing)

These live on the spoke's own origin. Paths are a hard contract where noted (the hub/clients hardcode them).

### Group A — Login bridge (T1)
| Endpoint | Method | Purpose | Calls on hub |
|---|---|---|---|
| `/api/auth/authorize` | GET | Initiate. Generate PKCE verifier + `state`, stash them + `returnUrl` in a short-lived httpOnly bridge cookie, 302 to the hub authorize URL with this spoke's `client_id` + exact `redirect_uri`. | redirect → `GET /api/auth/oauth/authorize` |
| `/api/auth/callback` | GET | Receive `?code&state`. Verify `state` vs the bridge cookie, exchange the code **server-to-server**, set the `civ-token` cookie, continue to `returnUrl`. **Path is fixed** (`SPOKE_CALLBACK_PATH`). | `POST /api/auth/oauth/session` |

### Group B — Session read (T0)
| Endpoint | Method | Purpose | Calls on hub |
|---|---|---|---|
| `/api/auth/session` | GET | The client `useSession`/SessionProvider polls this; returns `{ user, expires }`. Resolves via the session client (local verify → cache → identity on miss). | `GET /api/auth/identity` (only on cache miss) |

### Group C — Account switching (T2, same-origin proxies)
| Endpoint | Method | Purpose | Calls on hub |
|---|---|---|---|
| `/api/auth/accounts` | GET / DELETE | List the browser's device account-set (switcher) / remove one. Forwards the `civ-token` + `civ-device` cookies. | `GET /api/auth/accounts`, `DELETE /api/auth/accounts?userId=` |
| `/api/auth/switch` | POST | Switch to another account in the device set; sets the new `civ-token`, rolls `civ-device`. | `POST /api/auth/switch` |

### Group D — Lifecycle
| Endpoint | Method | Purpose | Calls on hub |
|---|---|---|---|
| `/api/auth/logout` | POST | Clear the spoke's cookies (civ-token + device + any legacy); best-effort revoke at the hub. | `POST /logout` |
| `/api/auth/impersonate` | POST / DELETE | (T3) Moderator impersonate / stop. Forwards the session cookie. | `POST /api/auth/impersonate`, `POST /api/auth/impersonate/exit` |

### App-specific (NOT part of the generic spoke kit)
`post-login` (main-app referral/tracking side-effects), `oauth/[...path]` (legacy-URL 308 shim), `jwks`
(only if the app *mints* its own tokens), `user-from-token`, `civ-token`, `freshdesk` — main-app-only; a new
spoke does not need these.

---

## 5. How a spoke validates & fetches session data

The cookie is a **thin** ES256 JWT — identity only (`sub`, `jti`, `signedAt`, optional `impersonatedBy`). No
embedded user. Everything else is resolved on demand.

### 5a. Validate (every request, no hub hop in steady state)
`createSessionClient({ isRevoked })` (or `createAuthVerifier` directly):
1. **Signature** — ES256 verified **locally** against the hub's JWKS, fetched once from `AUTH_JWKS_URI` and
   cached in-process (refetched only on an unknown `kid`, i.e. key rotation). The hub itself verifies with its
   local `AUTH_JWT_PUBLIC_KEY` instead.
2. **Issuer + expiry** — `iss` must equal `AUTH_JWT_ISSUER`; standard `exp`.
3. **Revocation** — the injected `isRevoked(claims)` checks the shared redis markers (`TOKEN_STATE[jti] ===
   'invalid'` or a global `SESSION:ALL` newer than `signedAt`). **Wire this in** — without it a logged-out or
   banned token still resolves on a cache hit. Fails **open** (a redis blip must not log everyone out).

### 5b. Fetch the rich user (`getSessionUser(token)`)
1. Verify (5a). On failure → `null` (unauthenticated).
2. **Shared redis cache** read (`session:data2:<userId>`). Hit → return (the warm path; no hub call).
3. **Miss → `GET {iss}/api/auth/identity`** with the token as a Bearer (single-flighted per `userId` to avoid
   a stampede). The hub is the sole producer (DB → cache). 401/404 → `null`.

> The hub's read source ([identity/+server.ts](../../apps/auth/src/routes/api/auth/identity/+server.ts)) is a
> read-through: warm cache when possible, produce-on-miss. Same caching for shared-redis and HTTP-only spokes.

### 5c. Keep it alive (rolling refresh)
The fixed-window token would expire even for an active user. When its age crosses `AUTH_SESSION_UPDATE_AGE`,
`createSessionTokenClient().refresh(token)` calls `POST /api/auth/refresh` (Bearer) → the hub re-mints the
**same** session (same `jti`, fresh window, `impersonatedBy` preserved) → the spoke re-sets the cookie.
Best-effort + timed out, so a hub blip leaves the current valid token in place. (Main app does this in
`getServerAuthSession` via `maybeRollHubCookie`.)

### 5d. Invalidate (ban / logout-everywhere / webhook)
`createSessionClient().invalidate(userId)` → `POST /api/auth/identity` with `AUTH_INTERNAL_TOKEN` → busts the
shared cache (lazy re-produce) and the hub writes the `TOKEN_STATE`/`SESSION:ALL` marker so live tokens fail
`isRevoked` on their next verify.

---

## 6. The spoke→hub contract (consolidated)

Server-to-server unless marked *(browser redirect)*. All resolved off `AUTH_JWT_ISSUER` via the package's
`hubFetch`, so a spoke can never point them anywhere but the hub.

| Hub endpoint | Auth | Used by | Purpose |
|---|---|---|---|
| `GET /api/auth/oauth/authorize` *(browser redirect)* | user session (hub cookie) | `/api/auth/authorize` | OAuth authorize; first-party skips consent |
| `POST /api/auth/oauth/session` | code + PKCE verifier + client_id | `/api/auth/callback` | First-party code → **civ-token session** |
| `GET /api/auth/identity` | Bearer = session token | `getSessionUser` (miss) | Fetch rich `SessionUser` |
| `POST /api/auth/identity` | Bearer = `AUTH_INTERNAL_TOKEN` | `invalidate`/`refresh` | Bust/re-produce cache for any user |
| `POST /api/auth/refresh` | Bearer = session token | rolling refresh | Re-mint same session, fresh window |
| `POST /logout` | session cookie | `/api/auth/logout` | Revoke the token |
| `GET/DELETE /api/auth/accounts` | civ-token + civ-device cookies | `/api/auth/accounts` | Device account-set |
| `POST /api/auth/switch` | civ-token + civ-device cookies | `/api/auth/switch` | Device account switch |
| `POST /api/auth/impersonate` (+ `/exit`) | session cookie | `/api/auth/impersonate` | Mod impersonation |
| `GET /api/auth/jwks` | public | the verifier | Public keys for local verify (via `AUTH_JWKS_URI`) |

Package clients that wrap these: `createSessionClient` (identity read + invalidate), `createSessionTokenClient`
(refresh + revoke), `createDeviceAccountClient` (accounts + switch), `createImpersonationClient`
(impersonate/exit), and the first-party helpers (`firstPartyClientId`, `SPOKE_CALLBACK_PATH`) +
`buildPostLoginRedirect` / `isCivitaiOrigin` for the redirect contract.

---

## 7. Config & registration checklist for a new spoke

**Env (spoke):**
- `AUTH_JWT_ISSUER` — the hub origin (`iss` + the `hubFetch` base). **Required.**
- `AUTH_JWKS_URI` — `{hub}/api/auth/jwks`, for local token verification. **Required** (unless the app is the
  hub and sets `AUTH_JWT_PUBLIC_KEY`).
- Shared **cache redis** — the `session:data2` read path. Strongly recommended (else every read hits the hub).
- Shared **sys redis** — for the `isRevoked` revocation markers.
- `AUTH_INTERNAL_TOKEN` — only if the app triggers cache invalidations (bans, webhooks).
- `NEXTAUTH_SECRET` — only during the legacy-cookie cutover window.

**Hub-side registration:**
- **`TrustedSpokeDomain` row** for the app's host (or an `includeSubdomains` parent). This is what makes the
  host first-party (consent-skip + session exchange). One row = one new login host. Dev `localhost`/`127.0.0.1`
  is auto-trusted, so local dev needs no row.
- `AUTH_CORS_ORIGINS` on the hub — only if the app calls `/api/auth/*` from the **browser** (credentialed CORS)
  rather than purely through its own server proxies.

---

## 8. Single source of truth for "our hosts" — IMPLEMENTED (2026-06-22)

There were three overlapping notions of "is this one of our apps": `CIVITAI_OWNED_DOMAINS` (the post-login
open-redirect guard), the `TrustedSpokeDomain` registry (OAuth trust), and the main app's `getAllServerHosts()`
(color-map).

**Done — the hub's post-login redirect guard now derives from the `TrustedSpokeDomain` registry:**
- New reusable utility `createTrustedDomainRegistry` in `@civitai/auth`
  ([trusted-domains.ts](../../packages/civitai-auth/src/trusted-domains.ts)) — an **in-memory TTL cache** (60s)
  over an **injected** loader (so the package keeps zero infra deps). Exposes `matchesHost` (OAuth trust),
  `ownedOriginCheck()` (registry ∪ owned-eTLD+1 backstop), and `invalidate()`.
- The hub wires **one shared instance** (`spokeDomains`) over the `TrustedSpokeDomain` Kysely query
  ([first-party.ts](../../apps/auth/src/lib/server/oauth/first-party.ts)) — the SAME cached snapshot now powers
  both first-party OAuth client resolution AND the redirect guard.
- The redirect guard ([redirect.ts](../../apps/auth/src/lib/server/auth/redirect.ts)) stays **sync + DB-free**:
  it takes an injected `isAllowedOrigin` defaulting to the static `isCivitaiOrigin`. The login handlers resolve
  `buildPostLoginOriginCheck()` (registry-aware) and pass it. `CIVITAI_OWNED_DOMAINS` is now the **fail-safe
  backstop** (a DB outage falls back to it; the static security test still exercises this floor) — no longer the
  thing you edit per host.

**Result:** onboarding a brand-new registrable domain is **one `TrustedSpokeDomain` row** — no constant edit.
Family subdomains (e.g. `moderator.civitai.com`) were already covered by the eTLD+1 backstop and need nothing.

**Still separate (by design / future work):** the main app's `getAllServerHosts()` (color-map of the deploy's
actually-served hosts) and the hub's CORS allowlist (`AUTH_CORS_ORIGINS`, env) remain their own mechanisms. They
*could* also derive from the registry, but that's a larger, separate change.

## 9. Packaging gap — toward a drop-in spoke kit

Already in `@civitai/auth` (reuse directly): `createSessionClient`, `createSessionTokenClient`,
`createDeviceAccountClient`, `createImpersonationClient`, `createAuthVerifier`, the cookie-name helpers,
`buildPostLoginRedirect`/`isCivitaiOrigin`, `hubFetch`, and the first-party id/path helpers.

Not yet packaged (each spoke currently hand-rolls these as framework routes): the **authorize/callback bridge**
logic (`oauth-bridge.ts`: derive-own-origin, PKCE/state stash, bridge cookie) and the thin HTTP handlers for
groups A–D. The next step toward "standard auth in any app" is to extract the bridge into a framework-thin
adapter (Next + SvelteKit shims) so a new spoke is: *import the adapter, mount the group-A–D routes, add one
`TrustedSpokeDomain` row, set env.* No bespoke crypto, no per-app constants.
