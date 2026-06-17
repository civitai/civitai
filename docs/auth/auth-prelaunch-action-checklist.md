# Auth Hub — Pre-Launch Action Checklist

**Date:** 2026-06-17 · **Derived from:** the auth doc set (see [../auth-index.md](./auth-index.md)).
Consolidates the actionable recommendations across the reviews/roadmaps into one to-do list, with source
file locations verified against HEAD. Ownership noted where it crosses session/app boundaries.

> **Framing:** the bespoke **swap bridge ships to prod NOW** and stays until the (deferred) OIDC convergence,
> so its blockers are **live in production** and must be fixed in the current push — they are *not* deferrable
> with the OAuth-provider work. Source: [auth-login-simplification.md](./auth-login-simplification.md),
> [oauth-provider-implementation-checklist.md §I](./oauth-provider-implementation-checklist.md).

---

## 1. Security blockers — fix before any deploy (`apps/auth` owner)

Status: fixed this session via verify-first TDD (B1/B2 by main session, B3/B4/B5 by sub-agents). **Uncommitted — pending review** (and the B4 part-2 decision). Each fix shipped with a regression test.

- [x] **B1 — open redirect. FIXED.** `redirect.ts:14` `origin.includes('civitai')` → exact eTLD+1 host check
  (rejects `civitai.evil.com` / `evil-civitai.com` / `civitai.com.attacker.io`). Substring-bypass test added (green).
- [x] **B2 — ban revocation: FALSE POSITIVE (verified in source).** Ban→revoke already works: the hub tracks
  each civ-token by its `jti` on mint (`session.ts:86,89`), `toggleBan` → `invalidateSession` marks
  `TOKEN_STATE[jti]='invalid'`, and the spoke `isRevoked` (`session-verifier.ts:21`) rejects on exactly that.
  The hub's `invalidateUserSessions` is unused/**redundant** (cleanup, not a hole). The real gap was *coverage* —
  added the end-to-end test `src/server/auth/__tests__/ban-session-revocation.test.ts` (5 cases, green).
- [x] **B3 — alg confusion: FIXED.** `verify.ts` now pins `algorithms: ['ES256']` (session + swap paths) and
  gates the legacy branch behind an explicit `legacyEnabled` kill-switch (was: implicit on secret presence).
  The review's "enforce issuer/audience on the legacy decrypt" was **NOT-SAFELY-ACTIONABLE** — legacy next-auth
  JWEs carry no `iss`/`aud`, so enforcing would reject every legacy cookie and break cutover login; `legacy-cookie.ts`
  left unchanged. *Follow-up:* wire `legacyEnabled` to an env var.
- [x] **B4 — swap token: FIXED (Option 2, decided 2026-06-17).** `consumeSwapToken` fails **closed** when
  sysRedis absent (`swap.ts`); `/exchange` is rate-limited (429). **Origin-binding deferred to the OIDC
  migration** — a self-asserted `X-Swap-Origin` is cosmetic (the swap value is observable in the callback URL;
  real spoke-binding needs client authentication, which OIDC auth-code provides). `bindSwapOrigin`/`checkSwapOrigin`
  reverted. Current swap replay-defense: signature + single-use + 60s TTL + `Referrer-Policy: no-referrer` +
  rate-limit. Hub suite 99 green, svelte-check clean.
- [x] **B5 — key-gen mismatch: FIXED.** `.env.example` + `auth-hub-launch-checklist.md` RSA/RS256 → EC P-256
  (`openssl ecparam -genkey -name prime256v1`); added boot-time `assertEcP256` in `sign.ts` (actionable error vs
  jose's cryptic `DataError`) + 2 tests.

## 2. Cutover correctness — finish before "hub is the only path"

- [x] **M2 — logout: FIXED.** `logout.ts` now clears the device cookie (both prefixes; extracted a testable
  `buildLogoutCookies()` helper + 3 tests). `AccountProvider.logoutAll` now removes the whole device account set +
  clears the local roster + runs logout (was a bare alias). *Follow-up:* no hub atomic "forget device's whole
  account set" route exists — a `DELETE /api/auth/accounts` (no `userId`) is still needed for true server-side
  sign-out-everywhere (`apps/auth` owner).
- [ ] **Swap dance: remove the redundant re-bounce** (auth-login-simplification #2) — mint the swap at hub
  login-completion when `returnUrl` targets an allowlisted spoke `/api/auth/sync`, redirect straight to it
  (~2 fewer redirects).
- [x] ~~M1 — strip NextAuth from the main app~~ ✅ done (this branch).
- [x] ~~M4 — drop in-app social login~~ ✅ done (this branch).

## 3. Operational — no safe launch without these

- [ ] **Rollback plan + session/account migration plan + monitoring/alerting.** The cutover doc removed the
  feature-flag safety net, so there is currently no documented way back. Write the runbook.
- [ ] **Real-IP env for rate-limit + Turnstile:** set `ORIGIN` / `ADDRESS_HEADER` / `XFF_DEPTH` (unset →
  limits go global).
- [ ] **`AUTH_SPOKE_ORIGINS`** must be set or cross-domain sync denies all callbacks.
- [ ] **Validate `.com ↔ .red` round-trip + cross-domain logout end-to-end** before flipping DNS. The tier-3
  Playwright specs (`tests/preview-auth-guard.spec.ts`, `apps/auth/e2e/hub-login.spec.ts`) cover parts; the
  full cross-site cookie mechanics still need the deployed preview/hub harness (can't run on localhost).

## 4. `@civitai/auth` package boundary

- [ ] **SDK owns cookie *names* but not *attributes*** (HttpOnly/SameSite/Domain/Secure) — each consumer
  hand-writes `Set-Cookie`. Consider centralizing the cookie-write in the SDK.
- [ ] **`isSecureCookie()` silent `false`** when neither `NEXT_PUBLIC_BASE_URL` nor `AUTH_JWT_ISSUER` is set →
  two spokes compute different cookie names and can't see each other's sessions. Assert env presence / fail loud.
- [ ] **Package ships raw `.ts`** (no build, no `types` export condition) — only typechecks transitively
  through consumers, and breaks non-bundler importers (hit this in the hub e2e harness; worked around by
  deriving the cookie name locally — `apps/auth/e2e/hub-auth.setup.ts`). Consider a real dual ESM+CJS build.
- [ ] **`next-auth` still a package dependency** (dynamic-import-only via `account-switch.ts`). Remove at
  cutover-complete — but **not before** legacy localStorage account-switch entries are unredeemable (ordering
  caveat from the review's recommended order #6).

## 5. Documentation hygiene

Doc-accuracy sweep complete (3 read-only audits). **Cookie minting verified SOUND** (names/prefixes/attributes/
claim-shape/resolution all correct in code + docs). Fixes below queued for the consolidated doc pass (uncommitted):

- [ ] **CRITICAL** `auth-hub-main-app-changes.md` — whole doc describes the abandoned **fat RS256** model →
  SUPERSEDED banner (→ [thin-session-token-design.md](./thin-session-token-design.md)).
- [ ] **CRITICAL** `auth-verification-strategy.md` — "Path C" pins **RS256 + an RSA keygen**; shipped is ES256
  and an RSA key now throws at boot (B5's `assertEcP256`) → correction.
- [ ] **CRITICAL** `main-app-auth-cutover.md` — presents the NextAuth strip as **pending** (it's done); stale
  `createSessionClient()` no-arg → `{ isRevoked }`; dead `civTokenDecrypt`/`next-auth-options` reason.
- [ ] **CRITICAL** `session-refresh-debug-instrumentation.md` — 3/7 revert targets moot (deleted files); the
  surviving debug block in `session-invalidation.ts:50-71` now **always fires** (dead `next-auth-options` guard)
  → mark moot + **remove the dead block in code**.
- [x] `auth-hub-launch-checklist.md` keygen RS256→EC — done as part of B5.
- [ ] **MINOR:** `thin-session-token-design.md:124,234` stray RS256; `centralized-auth-app.md:136` stale
  `SameSite:'none'`; `auth-hub-actual-flows.html` "4 redirects" wording; `auth-hub-spoke-overview.md:81`
  "planned"→built; `drop-main-app-social-login.md` status→complete + `getProvidersInProcess` deletable.

## 6. Deferred (post initial release — tracked, not for this launch)

- [ ] **OAuth2/OIDC *provider* migration into the hub** — entire
  [oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) (§A–§H). Dormant in
  the main app today; safe to defer (auto-memory: `oauth-provider-moves-to-hub`).
- [ ] **Converge first-party SSO onto OIDC auth-code** (§I + auth-login-simplification #3/#4) — *at* the OAuth
  migration. Retires the swap/exchange/sync bridge.
- [ ] **Freshdesk SSO** (`src/pages/api/auth/freshdesk.ts`) — separate shared-secret SSO bridge; eventual
  "hub owns all SSO" candidate, independent of the OIDC/key-centralization work.
