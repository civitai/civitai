# Auth Verification Strategy — Shared Library (A) vs JWKS Hybrid (C)

> **CORRECTION (2026-06-17):** the shipped 'Path C' uses **ES256 / EC P-256**, NOT RS256/RSA. Generate with `openssl ecparam -genkey -name prime256v1 -noout -out priv.pem` (then `openssl ec -in priv.pem -pubout -out pub.pem`) — an **RSA key now throws at boot** (`packages/civitai-auth/src/sign.ts` `assertEcP256`). Also: `getServerAuthSession` is fully cut over to the hub path; the '(not yet wired)' status notes below are historical.

**Status:** decision doc / proposal · **Date:** 2026-06-09
**Parent:** [centralized-auth-app.md](./centralized-auth-app.md) — that doc settles *topology* (hub issues, spokes verify). This doc settles **how a spoke verifies a session**, which determines whether auth changes force consumer redeploys.

## Implementation status (2026-06-09)

The `@civitai/auth` package and an **opt-in** Path-C wiring have landed (unstaged). Everything is a no-op until the RS256 keys are set, so the build/runtime are unchanged today.

**Package** [`packages/civitai-auth/`](../../packages/civitai-auth/) — `createAuthVerifier` (spoke: JWKS verify + legacy-JWE fallback + injected revocation), `createSessionSigner`/`maybeCreateSessionSigner` (hub: ES256 `mintSessionToken`/`mintSwapToken`/`mintIdToken`, `publicJwks`), `createAuthMiddleware` (edge guard). Deps: `jose` + `zod` only — `next-auth` was dropped once the cutover completed (the legacy `civitai-token` JWE is decoded with a standalone `jose` reimplementation in `legacy-cookie.ts`, no `next-auth` dependency). No infra deps (revocation is injected).

**Wired (opt-in, off unless `AUTH_JWT_PRIVATE_KEY` + `AUTH_JWT_KID` set):**

- Hub signer spread into next-auth `jwt:{encode,decode}` — [`next-auth-options.ts`](../../src/server/auth/next-auth-options.ts). Callbacks unchanged.
- JWKS endpoint [`/api/auth/jwks`](../../src/pages/api/auth/jwks.ts) (point `AUTH_JWKS_URI` here; `.well-known` rewrite optional).
- [`/api/auth/sync`](../../src/pages/api/auth/sync.ts) additionally returns a signed `swapToken` (legacy AES `token` kept).
- Main-app spoke verifier with **real** redis revocation injected — [`session-verifier.ts`](../../src/server/auth/session-verifier.ts) (not yet on the request path).
- Moderator spoke shim (signature-only) — [`apps/moderator/src/server/auth.ts`](../../apps/moderator/src/server/auth.ts).

**To turn Path C on:** generate an RSA keypair → set `AUTH_JWT_PRIVATE_KEY` (PKCS8) + `AUTH_JWT_PUBLIC_KEY` (SPKI) + `AUTH_JWT_KID` on the hub, `AUTH_JWKS_URI` + `AUTH_JWT_ISSUER` on spokes → run the HS256→RS256 migration window below.

**Not yet wired (behavior-changing, needs decisions):** flipping `getServerAuthSession` to `sessionVerifier`; the receive path (`useDomainSync`/`AccountProvider` to prefer `swapToken` via `createAccountSwitchProvider`); key storage (env vs KMS); standing up `apps/auth`.

Typecheck: main app + moderator both clean.

## The question

A spoke (main app, `apps/moderator`, future apps) receives a request with a session cookie. How does it decide *who the user is and whether they're allowed*?

Two viable answers (pure introspection — a hub call per request — was rejected for its per-request latency):

- **Path A — Shared library, symmetric secret.** Spokes import `@civitai/auth` and verify the cookie **in-process** with the shared `NEXTAUTH_SECRET`. This is the current next-auth behavior.
- **Path C — Asymmetric JWT + JWKS hybrid.** The hub signs the session JWT with a **private** key; spokes verify **in-process** with the hub's **public** key (cached from a JWKS endpoint), plus a redis revocation check.

Both verify locally — **neither adds a per-request network hop.** They differ in key distribution, blast radius, and *what you can change without redeploying spokes*.

---

## Path A — Shared library, symmetric secret

### Mechanics

- **Token:** next-auth default — a JWE/JWT keyed off `NEXTAUTH_SECRET` (symmetric). Every verifier needs the secret.
- **Verify:** `getToken({ req, secret })` from `next-auth/jwt`, decoded locally in the spoke.
- **Revocation:** redis invalidation marker (already exists — `session-invalidation.ts`).
- **Distribution:** `NEXTAUTH_SECRET` lives in **every** app's env; `@civitai/auth` verify code is compiled into every app's bundle.

### What's redeploy-free vs not

| Change | Consumer redeploy? |
|---|---|
| Add/change OAuth provider, login UI, email flow | **No** — hub-only |
| `SessionUser` shape mapping, civ-token decrypt, the guard | **Yes** — package code is compiled in |
| Secret rotation | No redeploy, but a **coordinated env rollout + restart on every app** |

### Pros / cons

- ✅ Simplest — no new infra, no key management, works with next-auth as-is.
- ✅ Lowest latency (pure local decode).
- ❌ The shared secret is distributed to every app → **large blast radius**; a single leaked spoke can *mint* valid sessions.
- ❌ Verification-logic changes (the package) need every consumer to rebuild+redeploy.
- ❌ Secret rotation is a fan-out env change across all apps.

### Migration steps (A)

1. `@civitai/utils` — extract the pure helpers auth needs.
2. `@civitai/auth` — verify (`getToken`+secret), `SessionUser`, `requireAuth`, civ-token, `account-switch` receiver, `syncAccount`, redis revocation. Repoint the 59 `~/server/auth/` call-sites.
3. `apps/auth` hub — move providers, `login/*`, `[...nextauth]`, `oauth/*`, `/api/auth/sync`.
4. `NEXTAUTH_SECRET` provisioned to every app; spokes redirect-on-miss to the hub.

---

## Path C — Asymmetric JWT + JWKS hybrid

### Mechanics

- **Token:** the hub signs the session JWT with a **private** key (RS256 or EdDSA), carrying a `kid` (key id). The cookie *is* the asymmetric-signed JWT.
  - Requires overriding next-auth's default symmetric `jwt.encode/decode` on the hub to sign with the private key. The hub is the only minter.
- **Public keys:** hub exposes `GET /.well-known/jwks.json` (public keys by `kid`).
- **Verify (spoke):** read cookie → `jwtVerify(token, remoteJWKS)` (jose `createRemoteJWKSet` caches the keyset and only refetches on an unknown `kid`) → claims. **No per-request hop** once cached.
- **Revocation:** same redis marker check. Short-lived tokens + revocation marker ≈ near-real-time logout/ban without introspection.
- **Cross-root swap:** convert the civ-token from AES-encrypted (symmetric, spoke needs the key) to an **asymmetric-signed JWS** (hub signs, spoke verifies via the same JWKS). This keeps spokes **holding no secret at all**, including on the swap path.

### What's redeploy-free vs not

| Change | Consumer redeploy? |
|---|---|
| **Signing key rotation** | **No** — spokes refetch JWKS on unknown `kid` |
| Add/change provider, login UI, email | **No** — hub-only |
| What claims the hub bakes **into** the token | **No** (as long as spokes read a stable subset) |
| Revocation policy (it's a hub mint-time + redis decision) | **No** |
| A claim *shape* a spoke reads, or a local check it runs | **Yes** — same as A (and as introspection) |

### Pros / cons

- ✅ **No shared secret distributed.** The private key lives only on the hub; spokes hold only public keys. A leaked spoke **cannot mint** tokens. Smallest blast radius.
- ✅ Key rotation, provider changes, and token-content changes are **zero-consumer-redeploy**.
- ✅ Onboarding a new app needs only the **JWKS URL** — no secret provisioning.
- ✅ Local verification, no per-request hop.
- ❌ More moving parts: key generation, a JWKS endpoint, a rotation runbook (publish old+new, retire old after max token TTL).
- ❌ Must override next-auth's symmetric JWT with RS256 signing (custom `encode`/`decode`).
- ⚠️ Signed JWTs are **readable** (not encrypted) — never put secrets in claims. Audit the current session payload before switching.

### Migration steps (C)

C is a **superset of A** — do A's steps 1–4 first, then swap the verification internals:

5. **Hub signing** — override next-auth `jwt.encode/decode` to RS256 with a private key from the secret manager. Add the `/.well-known/jwks.json` route. Convert civ-token to a signed JWS.
6. **Key management** — generate keypair, store private key (hub-only secret), publish the public JWKS. Write the rotation runbook (overlap window ≥ max session TTL).
7. **Spoke verify** — `@civitai/auth` swaps `getToken({secret})` for `jwtVerify(cookie, remoteJWKS)` + redis revocation. (The package gets *thinner and more stable* — its only volatile part is the `SessionUser` claim mapping.)

### Token-format migration window (HS256 → RS256)

Switching the signature algorithm is a token-format change, so stage it so no one is logged out:

1. Spokes accept **both** HS256 (old secret) **and** RS256 (JWKS) during the window.
2. Flip hub issuance to RS256.
3. After the max old-token TTL (e.g. 30 days, or force re-auth), drop HS256 acceptance and retire the secret.

This is exactly why **staging A → C is natural**: A ships the package + hub topology with today's symmetric tokens; C is then a contained, backward-compatible follow-up that touches only the hub (issuance) and the package (verify).

---

## Head-to-head

| | A — Shared library | C — JWKS hybrid |
|---|---|---|
| Per-request network hop | None | None |
| Secret on every spoke | **Yes** (`NEXTAUTH_SECRET`) | **No** (public key only) |
| Blast radius of a leaked spoke | Can mint tokens | Cannot mint |
| Key/secret rotation | Fan-out env change, all apps | Hub-only, zero consumer redeploy |
| Add a provider / change login | Hub-only | Hub-only |
| Change verify *logic* in the package | Consumer redeploy | Consumer redeploy |
| Onboard a new app | Provision the secret | Provision the JWKS URL |
| New infra | None | JWKS endpoint + key rotation runbook |
| Works with next-auth as-is | Yes | Needs custom `jwt.encode/decode` |

---

## Recommendation

**Target C, but stage through A.** Reasons:

- A is a strict prefix of C's work (extract `@civitai/auth`, stand up the hub). Shipping it first de-duplicates auth and proves the topology with zero new infra.
- C's *only* additional surface is *how the package verifies* (JWKS instead of secret) + *how the hub signs* (RS256) — a contained, backward-compatible follow-up via the migration window above.
- C is the design that actually delivers what prompted this: **consumer-redeploy-free auth changes** (keys, providers, token contents, revocation) **without** the per-request hop of introspection. The shared-secret blast radius in A only grows as you add apps; C removes it.

**Pick A as the destination only if** you're confident the app set stays small, all apps share one trust boundary, and you accept fan-out secret rotation and occasional consumer redeploys for verify-logic changes — in exchange for never running key infrastructure.

### Net for both: what still forces a lockstep deploy

In **either** path, the things that force coordinated consumer updates are the same and unavoidable: changing a **claim shape** a spoke reads, or a **check a spoke runs locally**. Keep the token contract additive/backward-compatible (parent doc §5) and those coordinations stay rare and order-independent.

---

## Open questions

- **Key storage** — where does the hub's private key live (env, cloud KMS, sealed secret)? KMS-backed signing keeps the private key off app hosts entirely.
- **Token TTL vs revocation latency** — shorter session TTL shrinks the revocation-staleness window but raises re-sign frequency. Current `maxAge` is 30 days ([`next-auth-options.ts:157`](../../src/server/auth/next-auth-options.ts#L157)); revisit for C.
- **Session payload audit** — confirm nothing sensitive rides in the JWT before moving from JWE (encrypted) to JWS (readable).
- **civ-token** — confirm we convert the swap transport token to signed JWS in C so spokes stay secret-free.
