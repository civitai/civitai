# Auth Hub — Pre-Launch Action Checklist

**Date:** 2026-06-17 · **Derived from:** the auth doc set (see [../auth-index.md](../auth-index.md)).
Consolidates the actionable recommendations across the reviews/roadmaps into one to-do list, with source
file locations verified against HEAD. Ownership noted where it crosses session/app boundaries.

> **Framing:** the bespoke **swap bridge ships to prod NOW** and stays until the (deferred) OIDC convergence,
> so its blockers are **live in production** and must be fixed in the current push — they are *not* deferrable
> with the OAuth-provider work. Source: [auth-login-simplification.md](../auth-login-simplification.md),
> [oauth-provider-implementation-checklist.md §I](./oauth-provider-implementation-checklist.md).

---

## 1. Security blockers — fix before any deploy (`apps/auth` owner)

Confirmed still-open in source; all in the hub/package, untouched by the main-app cutover.

- [ ] **B1 — open redirect.** `apps/auth/src/lib/server/auth/redirect.ts:14` — replace
  `origin.includes('civitai')` with an exact eTLD+1 allowlist (`host === 'civitai.com' || host.endsWith('.civitai.com') || host === 'civitai.red' || host.endsWith('.civitai.red')` + dev localhost). *Highest single risk.*
- [ ] **B2 — ban does not revoke sessions.** `apps/auth/src/lib/server/auth/registry.ts:19` —
  `invalidateUserSessions` is an **empty no-op stub**. Wire it to the actual session-registry invalidation and
  call it from ban + the `/api/auth/identity` invalidation path.
- [ ] **B3 — legacy cookie + alg confusion.** `packages/civitai-auth/src/legacy-cookie.ts` — enforce
  `issuer` (and audience) on the legacy decrypt; in `verify.ts` pin `algorithms: ['ES256']` explicitly and
  gate the legacy branch behind an explicit "legacy enabled" flag (removed at cutover), not implicit secret presence.
- [ ] **B4 — swap token.** `apps/auth/src/lib/server/auth/swap.ts:20` fail **closed** (not `return true`)
  when `REDIS_SYS_URL` is absent; bind the swap to the redeeming spoke origin (put it in the claims, verify at
  `/exchange`); rate-limit `apps/auth/.../api/auth/exchange/+server.ts` (currently unauthenticated + unlimited).
- [ ] **B5 — key-gen doc/code mismatch.** `apps/auth/.env.example:20-21` + `auth-hub-launch-checklist.md`
  say RSA/RS256; code is ES256/EC P-256. Change to `openssl ecparam -genkey -name prime256v1 …` and assert the
  imported key's curve at boot.

## 2. Cutover correctness — finish before "hub is the only path"

- [ ] **M2 — logout.** `src/pages/api/auth/logout.ts` clears session cookies but **not** the device cookie
  (`deviceCookieName()`); clear it. And `src/components/CivitaiWrapped/AccountProvider.tsx:196`
  `logoutAll = logout` (TODO) — implement real "sign out everywhere" once the hub exposes the call.
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

- [ ] Mark **`auth-hub-main-app-changes.md`** superseded — it describes the abandoned **fat RS256** token;
  shipped design is **thin ES256** ([thin-session-token-design.md](../thin-session-token-design.md)).
- [ ] **`auth-hub-launch-checklist.md` #8/#11** fat-token framing — same supersession note.
- [ ] **`thin-session-token-design.md`** drift — it claims `createSessionClient()` takes no args, but the
  revocation fix reintroduced `createSessionClient({ isRevoked })`. Reconcile.

## 6. Deferred (post initial release — tracked, not for this launch)

- [ ] **OAuth2/OIDC *provider* migration into the hub** — entire
  [oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) (§A–§H). Dormant in
  the main app today; safe to defer (auto-memory: `oauth-provider-moves-to-hub`).
- [ ] **Converge first-party SSO onto OIDC auth-code** (§I + auth-login-simplification #3/#4) — *at* the OAuth
  migration. Retires the swap/exchange/sync bridge.
- [ ] **Freshdesk SSO** (`src/pages/api/auth/freshdesk.ts`) — separate shared-secret SSO bridge; eventual
  "hub owns all SSO" candidate, independent of the OIDC/key-centralization work.
