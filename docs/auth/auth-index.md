# Auth Documentation — Index

**Central index for the NextAuth → centralized-hub auth migration.** Start here; every auth doc in the repo is
linked below with a one-line purpose, grouped by what you're trying to do.

The migration deploys **`apps/auth`** to **auth.civitai.com** as the sole login authority/session issuer.
**civitai.com** (same registrable domain) and **civitai.red** (separate, for legal reasons) both authenticate
through it. Sessions are a thin **ES256 `civ-token`** cookie + shared-Redis `SessionUser`, verified by spokes
via JWKS. See the architecture spec and actual-flows first if you're new to it.

---

## Current state (2026-06-17)

- ✅ **Main app cut over** — NextAuth deleted from the main app (`[...nextauth].ts`, `next-auth-options.ts`
  removed; first-party `SessionProvider`/`getServerAuthSession`). In-app social-login UI dropped; `/login` is now
  a server-side redirect to the hub.
- ✅ **Thin ES256 token** is the shipped model (supersedes the older "fat RS256 token" framing in some docs —
  see notes below).
- ⏸️ **OAuth2/OIDC *provider* migration into the hub is deferred** past this initial release (decision
  2026-06-17). It's dormant in the main app today (signing gated on keys being configured). See the provider
  plan + checklist below.
- 🔴 **Open swap-bridge / hub blockers persist into prod** (the swap bridge ships now and stays until the
  deferred OIDC convergence): **B1** open-redirect, **B2** ban-doesn't-revoke (no-op stub), **B4** swap
  fail-open without Redis, **B5** `.env.example` RSA-vs-ES256, **M2** logout device-cookie. Tracked in the
  cutover review below.

---

## Start here (architecture & decisions-of-record)

| Doc | Purpose |
|---|---|
| [auth-hub-spoke-overview.md](./auth-hub-spoke-overview.md) | The architecture **spec** — how auth is *supposed* to work across the monorepo (intent, not cutover steps). |
| [centralized-auth-app.md](./centralized-auth-app.md) | Topology decision: hub issues, spokes verify + the `@civitai/auth` SDK. (2026-06-09) |
| [auth-verification-strategy.md](./auth-verification-strategy.md) | How a spoke verifies a session — Shared-lib (A) vs JWKS hybrid (C). Determines whether auth changes force consumer redeploys. (2026-06-09) |
| [thin-session-token-design.md](./thin-session-token-design.md) | The **thin ES256 token** model — *decided*; supersedes the fat-token framing elsewhere. |

## Visual reference (read alongside the specs)

| Doc | Purpose |
|---|---|
| [auth-hub-actual-flows.html](./auth-hub-actual-flows.html) | UC1–UC8 login/logout/switch/impersonation flows **as implemented**, + a cookie reference. |
| [first-party-sso-vs-oauth-diagrams.html](./first-party-sso-vs-oauth-diagrams.html) | Current (swap-token) vs proposed (OIDC auth-code) wire diagrams. |

## First-party SSO simplification (swap bridge → OIDC)

| Doc | Purpose |
|---|---|
| [first-party-sso-vs-oauth-analysis.md](./first-party-sso-vs-oauth-analysis.md) | Argues the swap-token flow is a hand-rolled auth-code flow; recommends converging onto OIDC while keeping the thin session cookie (BFF). (2026-06-17) |
| [auth-login-simplification.md](./auth-login-simplification.md) | Roadmap: harden + slim the swap bridge **now**, converge to OIDC auth-code **at the OAuth migration**. (2026-06-17) |
| [oauth-first-party-migration-plan.md](./oauth-first-party-migration-plan.md) | **Execution plan** for the convergence — sequenced phases (provider-into-hub → trusted clients → spoke auth-code bridge → dual-run → delete swap), with the cookie-safety invariant + rollback. |

## Cutover execution (NextAuth → hub)

| Doc | Purpose |
|---|---|
| [main-app-auth-cutover.md](./main-app-auth-cutover.md) | Main-app cutover status + the "strip NextAuth before ship" decision. |
| [auth-hub-main-app-changes.md](./auth-hub-main-app-changes.md) | Main-app support for the hub + `@civitai/auth` consolidation. ⚠️ Parts describe the abandoned **fat RS256** model — superseded by [thin-session-token-design.md](./thin-session-token-design.md). |
| [auth-hub-launch-checklist.md](./auth-hub-launch-checklist.md) | Outstanding work before auth.civitai.com ships (infra/severity). ⚠️ #8/#11 fat-token framing superseded by the thin-token design. |
| [plans/drop-main-app-social-login.md](./drop-main-app-social-login.md) | Checklist for dropping in-app social-login buttons (largely landed). (2026-06-17) |

## Reviews & findings

| Doc | Purpose |
|---|---|
| [auth-hub-cutover-review-2026-06-17.md](./auth-hub-cutover-review-2026-06-17.md) | **Latest** cutover review — blockers B1–B5, major M1–M4. (M1/M4 have since landed — see the freshness note at its top; remaining blockers are hub/package.) |
| [auth-review-synthesis.md](./auth-review-synthesis.md) | Synthesis of two independent subagent reviews of the hub↔spoke work. (2026-06-15) |
| [auth-cross-domain-review.md](./auth-cross-domain-review.md) | Review of the cross-domain swap-token exchange specifically. (2026-06-15) |
| [plans/auth-prelaunch-action-checklist.md](./auth-prelaunch-action-checklist.md) | **Consolidated to-do list** derived from all the docs — blockers, operational gaps, package boundary, doc hygiene, deferred work — with source locations. (2026-06-17) |

## OAuth2/OIDC provider migration (deferred — see Current state)

| Doc | Purpose |
|---|---|
| [plans/oauth-provider-to-auth-app.md](./oauth-provider-to-auth-app.md) | The phased plan/rationale for moving the OAuth provider into the hub. (2026-06-10) |
| [plans/oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) | Actionable build checklist (incl. §I: first-party bridge → OIDC). Scope decision (open-Q #1) now answered — **deferred**. |
| [plans/oauth-scoped-tokens.md](./oauth-scoped-tokens.md) | OAuth server & scoped-tokens plan. |
| [plans/oauth-scoped-tokens-checklist.md](./oauth-scoped-tokens-checklist.md) | Scoped-tokens implementation checklist. |
| [plans/oauth-scoped-tokens-review.md](./oauth-scoped-tokens-review.md) | Scoped-tokens review checklist (pre-prod). |
| [plans/oauth-resume-state.md](./oauth-resume-state.md) | Resume state for the `feature/scoped-tokens` branch. |
| [plans/oauth-developer-docs.md](./oauth-developer-docs.md) | External-facing Civitai OAuth developer guide. |

## Operational / misc

| Doc | Purpose |
|---|---|
| [releasing.md](./releasing.md) | How to cut a hub release — `pnpm run release:auth[:minor\|:major]` → `auth-app-vX.Y.Z` tag → in-cluster Tekton build → ghcr → Flux. |
| [session-refresh-debug-instrumentation.md](./session-refresh-debug-instrumentation.md) | Tracks temporary diagnostic logs added during session-refresh investigations, for clean revert. |
| [post-deploy-domain-env-consolidation.md](./post-deploy-domain-env-consolidation.md) | Planned follow-up: collapse the overlapping domain/origin env vars (retire `NEXT_PUBLIC_BASE_URL`) onto the color-map source of truth. |

---

*New auth doc? Add it to the right group above with a one-line purpose so this stays the single front door.*
