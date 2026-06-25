# Centralized Login/Authorization App + `@civitai/auth` SDK

> **SUPERSEDED / HISTORICAL** — This is the pre-thin / pre-OAuth-bridge proposal. The migration shipped: the swap-token bridge and `USE_HUB_SESSION` are gone, and cross-domain login now uses the OAuth authorization-code + PKCE first-party bridge. See [spoke-integration-guide.md](./spoke-integration-guide.md) and [auth-hub-spoke-overview.md](./auth-hub-spoke-overview.md) for the current state.

**Status:** analysis / proposal · **Date:** 2026-06-09
**Related:** base-package rules (auto-memory: `monorepo-bootstrap-base-package-rules`) · [moderator-app-package-boundary.md](../moderator-app-package-boundary.md) · [monorepo-split-overview.md](../monorepo-split-overview.md) · [sync-account-utility-migration.md](../sync-account-utility-migration.md)

## Goal

Stand up a single **login/authorization app** (`auth.civitai.com`) that owns *all* auth surface — providers, login UI, token issuance, the OAuth server. Every other Civitai app (main, `apps/moderator`, future apps) stops hosting login logic; it only **verifies** a session and **redirects to the auth app on miss**.

Open question this doc settles: **do we still need a separate `@civitai/auth` package, or does the app replace it?** Short answer: **both** — the app is the issuer (a deployable, not importable); the package is the verify/receive SDK (importable by every app, including the auth app). They are two halves, not alternatives. See [§4](#4-do-we-still-need-a-package).

---

## 1. What already exists (the foundation is mostly built)

### 1a. Stateless sessions + subdomain cookie

- **JWT session strategy** — [`next-auth-options.ts:156`](../../src/server/auth/next-auth-options.ts#L156). Any app with `NEXTAUTH_SECRET` verifies a user with no DB round-trip. This is the linchpin.
- **Dot-domain cookie** — [`next-auth-options.ts:527`](../../src/server/auth/next-auth-options.ts#L527): `domain: NEXTAUTH_COOKIE_DOMAIN ?? '.' + hostname`, with the **`__Secure-`** prefix ([`libs/auth.ts`](../../src/libs/auth.ts)) — not `__Host-` (which forbids `Domain` and would break sharing). So a `.civitai.com` cookie is already visible to every `*.civitai.com` subdomain.

### 1b. The cross-ROOT-domain handoff is already implemented

This is the key discovery. We serve multiple **registrable** domains (civitai.**com** = green, civitai.**red** = red, …), and a cookie cannot span roots. The existing **`syncAccount` / civ-token swap** bridges them — a token-handoff in everything but name:

```text
A (green, .com)                          B (red, .red)
──────────────                           ──────────────
link wrapped by syncAccount(url)
  → ?sync-account=green        ───nav──▶ useDomainSync reads param
                                         fetch(//green-host/api/auth/sync,
                                               {credentials:'include'})   ──┐
  /api/auth/sync (AuthedEndpoint)  ◀───────────────────────────────────────┘
  cookie for .com is sent → authed
  civTokenEncrypt(userId)      ───────▶  { token, userId, username }
                                         swapAccount(token)
                                         → signIn('account-switch', token)
                                         → civTokenDecrypt → local .red session
```

Files: [`syncAccount`](../../src/utils/sync-account.ts) (builds the link) · [`useDomainSync`](../../src/hooks/useDomainSync.tsx) (pulls on the destination) · [`/api/auth/sync`](../../src/pages/api/auth/sync.ts) (mints the civ-token) · `account-switch` credentials provider in [`next-auth-options.ts`](../../src/server/auth/next-auth-options.ts) · [`civ-token.ts`](../../src/server/auth/civ-token.ts) (AES encrypt/decrypt of the userId transport token).

**Implication:** the multi-root problem is solved. What we're changing is *topology*, not inventing a handoff.

### 1c. We already run an OAuth authorization server

`src/pages/api/auth/oauth/{authorize,token,device,revoke}` + `src/pages/login/oauth/*`. Natural tenants of the auth app.

---

## 2. The topology shift: peer-to-peer → hub-and-spoke

**Today (peer-to-peer):** every color domain is a full app that is *both* issuer and verifier. Each holds its own session cookie; they swap civ-tokens peer-to-peer via `syncAccount`. Login UI + providers are duplicated into every deployment.

**Proposed (hub-and-spoke):** one **hub** issues; everyone else is a **spoke** that verifies.

```text
                    ┌──────────────────────────────────────────┐
                    │  HUB — apps/auth  →  auth.civitai.com      │
                    │  • login pages + 5 providers               │
   no/invalid       │  • [...nextauth] (issue), oauth/* server   │
   session    ┌────▶│  • email / recaptcha / blocklist           │
  ┌───────────┘     │  • /api/auth/sync  (mints civ-token)       │
  │  redirect       │  • ISSUES master cookie on .civitai.com    │
  │  ?callbackUrl   └───────────┬──────────────────────────────┬─┘
  │                             │ shared .civitai.com cookie    │ civ-token swap
  │             ┌───────────────┴──────────┐         ┌──────────┴───────────────┐
  │             │  SPOKE  (*.civitai.com)   │         │  SPOKE  (civitai.red,…)   │
  └─────────────┤  moderator, main, …        │         │  different root domain    │
                │  • cookie visible for free │         │  • can't see .com cookie  │
                │  • verify locally (JWT)    │         │  • receives via swap      │
                │  • NO login UI             │         │    (account-switch prov.) │
                └────────────────────────────┘         └───────────────────────────┘
                          both use ▼
                    ┌──────────────────────────────────────────┐
                    │  @civitai/auth (package / SDK)             │
                    │  verify · SessionUser · requireAuth guard  │
                    │  civ-token · account-switch receiver       │
                    │  syncAccount() · redis revocation check    │
                    └──────────────────────────────────────────┘
```

Two spoke flavors:

- **Same-root spoke (`*.civitai.com`)** — gets the `.civitai.com` cookie for free. Pure verifier: no next-auth providers, no login UI. On miss → redirect to `auth.civitai.com/login?callbackUrl=<self>`.
- **Cross-root spoke (`civitai.red`, `civitaic.com`)** — can't see the hub cookie. Keeps the **receive half** of the swap (the `account-switch` provider + `civTokenDecrypt`) to mint its own local session, pulling the civ-token from the hub instead of from a peer. `syncAccount` re-points from peer-host to hub-host.

---

## 3. Where each file lands

| File / concern | Destination | Why |
|---|---|---|
| `next-auth-options.ts` providers (Discord/Google/GitHub/Reddit/Email/Credentials) | **`apps/auth`** (hub) | Only the issuer runs login providers |
| `src/pages/login/*`, `[...nextauth]`, `oauth/*` | **`apps/auth`** | Login UI + token endpoints |
| `email/templates`, `recaptcha/client`, `blocklist.service` coupling | **`apps/auth`** (local imports) | Issuer-only deps — **never need injecting now** |
| `/api/auth/sync` (mint civ-token) | **`apps/auth`** | Hub is the session-of-record for swaps |
| `civ-token.ts` (AES encrypt/decrypt) | **`@civitai/auth`** | Hub *encrypts*, spokes *decrypt* — shared |
| `account-switch` provider (receive swap) + minimal next-auth | **`@civitai/auth`** factory | Every cross-root spoke mints a local session |
| `session-user.ts` (`SessionUser` shape, `getSessionUser`) | **`@civitai/auth`** | Spokes need the user shape |
| `get-server-auth-session.ts`, `bearer-token.ts` (verify paths) | **`@civitai/auth`** | The read/verify surface |
| `session-invalidation.ts`, `token-refresh.ts`, `token-tracking.ts`, `session-cache.ts` | **`@civitai/auth`** | Revocation marker spokes must honor (§5.2) |
| `syncAccount()` + `useDomainSync` | **`@civitai/auth`** (client subpath) | Spokes build cross-root links + receive |

The package depends **downward** on already-extracted infra (`@civitai/db`, `@civitai/redis`, `@civitai/db-schema`). It is a **higher-tier domain package** (like the proposed `@civitai/moderator-server`), so composing db+redis is allowed — base-package rules only bind the infra tier.

---

## 4. Do we still need a package?

**Yes** — and the reason is concrete: an *app* is a deployable that other apps cannot `import`. Spokes need shared **code** for the things they do locally:

1. **Verify** a JWT session (`getToken` + secret) and shape it into `SessionUser`.
2. **Receive a swap** — the `account-switch` credentials provider + `civTokenDecrypt` (cross-root spokes mint their own session).
3. **Guard** — a `requireAuth`/middleware that redirects to the hub on miss.
4. **Build cross-root links** — `syncAccount(url)` pointed at the hub.
5. **Honor revocation** — check the redis invalidation marker (§5.2).

All five are TypeScript that runs *inside each spoke*, so they must be a package. The hub imports the package too (civ-token crypto, `SessionUser`). **App = issuer surface; package = verify/receive SDK. Complementary.**

### The one scenario where you could skip the package

A **thin-client / token-introspection** model: spokes hold zero shared TS and instead call `POST auth.civitai.com/introspect` over HTTP on every request to validate a token. Tradeoffs:

- ✅ No shared code; spokes are language-agnostic.
- ❌ A network hop per auth check — you'd **throw away the stateless-JWT win you already have**.
- ❌ You'd still want a tiny client wrapper anyway.

**Recommendation: thick client (the package).** It matches the existing stateless-JWT + civ-token design and keeps verification local. Reserve introspection only if a non-JS app ever needs auth.

> **How the package verifies** — symmetric shared secret vs. asymmetric JWKS — is its own decision, and it determines whether auth changes force consumer redeploys. See [auth-verification-strategy.md](./auth-verification-strategy.md) (Path A vs Path C). Both keep verification local; C removes the shared-secret blast radius and makes key/provider/token changes consumer-redeploy-free.

---

## 5. Caveats / remaining work

1. **SameSite audit.** Cookies are `sameSite:'none'` for non-localhost ([`:522`](../../src/server/auth/next-auth-options.ts#L522)). For same-root subdomain *navigation* (top-level GET redirects to/from the hub) `lax` suffices and is safer; `none` is only needed for credentialed cross-site `fetch`. Note `/api/auth/sync` is a credentialed cross-origin `fetch` → that path genuinely needs `none` + CORS. Audit per-cookie before tightening.

   > **RESOLVED** — the shipped thin-session `civ-token` cookie is `SameSite=Lax`; cross-root `/api/auth/sync` uses a top-level Lax navigation, not a credentialed `none` fetch.

2. **Stateless logout / ban revocation.** A JWT can't be un-issued. We already have `session-invalidation` + `token-refresh` + a redis marker; the spoke verifier must check it (or tolerate staleness up to the refresh interval). This is the one place a spoke keeps a `@civitai/redis` dependency — fine, it's a base package.

3. **`/api/auth/sync` CORS hardening.** Today it answers any `credentials:'include'` caller. With a hub, lock its `Access-Control-Allow-Origin` to the known spoke roots and keep the civ-token short-TTL + single-use to bound replay.

4. **OAuth callbacks consolidate** to `auth.civitai.com/api/auth/callback/<provider>` — a simplification (one redirect URI per provider) matching the existing `auth.civitaic.com` preview precedent. Requires updating each provider console.

5. **Per-domain theming + bounce-back.** The hub must preserve which root the user came from (carried in `callbackUrl`) to theme and redirect back. The existing `domainColor` override ([`:577-611`](../../src/server/auth/next-auth-options.ts#L577-L611)) already models per-domain cookie behavior.

6. **`bearer-token.ts` / API keys** are DB-backed, not JWT. Decide whether key validation lives in the package (every app validates against the shared DB) or proxies to the hub. Lean: package — it's the same `@civitai/db` every spoke already has.

---

## 6. Phasing

1. **`@civitai/utils`** — extract the pure helpers auth needs (`createLogger`, `isDefined`, `withRetries`, `getRandomInt`, `generateToken`, `getUserBanDetails`). Low risk; unblocks more than auth.
2. **`@civitai/auth`** — verify + `SessionUser` + `requireAuth` + civ-token + `account-switch` receiver + `syncAccount` + revocation check, consuming `@civitai/{db,redis,db-schema,utils}`. Inject the few schema types rather than standing up a full schema package. Repoint the **59** main-app `~/server/auth/` call-sites and the syncAccount client sites onto the package barrel. *Delivers the shared SDK with no app yet.*
3. **`apps/auth` (hub)** — move providers, `login/*`, `[...nextauth]`, `oauth/*`, `/api/auth/sync` into the new app. Productionize `NEXTAUTH_COOKIE_DOMAIN=.civitai.com`. Point every spoke's redirect-on-miss at it. Give the app its own empty `instrumentation.ts` + `proxy.ts` (second-app shadowing gotcha).
4. **Re-point cross-root sync** — `syncAccount` + `useDomainSync` pull from the hub instead of peer color-domains; lock down `/api/auth/sync` CORS (§5.3).

Steps 1–2 ship the SDK and de-duplicate auth code with zero topology change. Step 3 centralizes login. Step 4 flips the swap source from peer to hub. Each step is independently shippable.

---

## 7. Open questions for the team

- **Naming** — package `@civitai/auth`, app `apps/auth` (hub). Confirm to avoid issuer/SDK confusion.
- **Are `.com` and `.red` one deployment or two?** The host-header `domainColor` logic implies one app serving many domains. If so, "all auth in one app" is a real consolidation, but the cross-root cookie limit (hence the swap) persists regardless — it's a browser constraint, not a deployment one.
- **Minimal next-auth on same-root spokes** — same-root spokes can verify the shared cookie with *zero* next-auth (just `getToken`). Confirm we don't need the `account-switch` provider on `*.civitai.com` spokes (only cross-root ones), keeping those spokes provider-free.
