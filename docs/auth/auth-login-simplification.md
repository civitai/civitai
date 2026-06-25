# Auth Login — Simplification Roadmap

> **SUPERSEDED / HISTORICAL** — The migration shipped. The swap-token bridge and `USE_HUB_SESSION` have been removed; the TL;DR below calling the swap bridge "the long-term production mechanism" is now false. Cross-domain login is now the OAuth authorization-code + PKCE first-party bridge. See [spoke-integration-guide.md](./spoke-integration-guide.md) and [auth-hub-spoke-overview.md](./auth-hub-spoke-overview.md) for the current state.

**Author:** Claude (Opus 4.8) · **Date:** 2026-06-17 · **Status:** roadmap / decision-of-record
**Companions:** [auth-hub-actual-flows.html](./auth-hub-actual-flows.html) (what exists today) ·
[auth-hub-cutover-review-2026-06-17.md](./auth-hub-cutover-review-2026-06-17.md) (findings, incl. B1/B4) ·
[plans/oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) (§I — the migration step)

> Read `auth-hub-actual-flows.html` first if you haven't — this doc assumes the UC1–UC8 flows and the
> "B-number" review findings.

---

## TL;DR

The login flow is convoluted because the main app serves multiple **color domains** (`green`/`blue`/`red`,
see `src/shared/constants/domain.constants.ts`) and `civitai.red` is a separate registrable domain that
**must stay separate for legal reasons**. A `.red` browser context cannot read the hub's `.civitai.com`
cookie, so cross-domain login uses a bespoke **swap-token bridge** (UC4). Decisions:

1. **Defer the OAuth-provider migration** — verified safe for existing session cookies (below).
2. **Harden + slim the swap bridge now** — it becomes the long-term production mechanism, so fix B1/B4,
   fail closed without Redis, and remove the redundant re-bounce.
3. **Unify the two login paths at the OAuth migration**, onto the standard OIDC authorization-code bridge
   — once, on the hardened path. Don't push `civitai.com` onto the swap bridge in the meantime.

---

## The irreducible bridge floor (why `.red` login can't be "one hop")

Because the `.red` browser context physically cannot read a `.civitai.com` cookie, establishing a `.red`
session **requires**, at minimum:

- **one redirect to the hub** (so the hub's own cookie proves who the user is), and
- **one single-use credential** the `.red` server redeems for a session.

That is the floor the browser security model imposes — you cannot get below "one hub round-trip + one
redemption." `.red` cannot be collapsed under `.civitai.com` (legal separation), so the goal is to **shrink
and standardize the bridge, not eliminate it**. Note the cost is **per cross-root color domain**: every
color that isn't under the `.civitai.com` parent pays this bridge independently — which is the main argument
for one *standard* mechanism rather than a bespoke one maintained N times.

`civitai.com` does **not** pay this — it shares the hub's parent domain, so the hub's `Set-Cookie` is
directly readable (UC3). Only cross-root colors need the bridge.

---

## Deferring the OAuth migration is cookie-safe (verified in source)

**The session cookie is decoupled from the bridge mechanism.** `setSessionCookie()`
([src/server/auth/civ-cookie.ts](../../src/server/auth/civ-cookie.ts)) writes the cookie from *any*
hub-minted token, using the package's `sessionCookieName()` / `isSecureCookie()` and a host-derived
`Domain`. It does not care whether the token came from a swap exchange, an account switch, impersonation,
or rolling refresh. The token is the hub's thin ES256 output, and every request resolves it the same way
via `getServerAuthSession` → verify (JWKS) → shared Redis → hub on miss
([src/server/auth/get-server-auth-session.ts](../../src/server/auth/get-server-auth-session.ts)) — again
independent of how the cookie was delivered.

So when the bridge later becomes OIDC authorization-code, the `/token` exchange returns the **same**
hub-minted civ-token and the spoke calls the **same** `setSessionCookie`. **Existing cookies stay valid and
users stay logged in across the migration**, provided:

1. the signing keys (`kid`) and the cookie name/domain logic don't change — they live in `@civitai/auth`,
   single source of truth; and
2. both bridge paths run **side-by-side** during the migration deploy, so in-flight logins aren't dropped.

The migration changes only the **login bootstrap**. It never touches stored cookies, per-request
resolution, or the shared session cache. This is why the migration can be deferred without risk to
production sessions.

---

## Four sources of complexity, and how each simplifies

| # | Source | Status / action |
|---|---|---|
| 1 | **Cross-registrable-domain** (`.red` can't read `.civitai.com` cookie) | **Irreducible** given legal separation. Shrink the bridge, don't remove it. |
| 2 | **Redundant re-bounce** in the cross-site dance (UC4 hub→spoke→hub→spoke) | **Remove now.** Mint the swap at hub login-completion when `returnUrl` targets an allowlisted spoke `/api/auth/sync`, and redirect straight to it — saving ~2 redirects. |
| 3 | **Bespoke vs standard credential** (swap token vs authorization code) | **→ OIDC at the migration.** Replace swap with auth-code; inherit `state`/PKCE/`redirect_uri` binding (kills B1/B4); reuse the OAuth provider's `/authorize`+`/token`. |
| 4 | **Two divergent paths** (`hubLoginEntryUrl` branches same-site vs cross-site) | **Unify at the migration**, onto the one auth-code path. Keep `civitai.com` direct until then. |

There is also an **orthogonal** complexity layer: the popup + `BroadcastChannel` + `popup-done` +
`post-login` choreography (UC3/UC4 tail). It has nothing to do with cross-domain — it's a UX choice. A
full-page redirect login would remove it entirely. Out of scope here; flagged so it isn't conflated with
the cross-domain work.

---

## Swap bridge vs OIDC authorization-code, side by side

The two bridges are the **same four steps** — OIDC is a *consolidation + hardening*, not a hop reduction:

| Step | Swap bridge (today) | OIDC auth-code bridge (at migration) |
|---|---|---|
| 1. Spoke sends browser to hub | `GET hub/api/auth/sync?callback=red/sync` | `GET hub/authorize?client_id=red&redirect_uri=red/cb&PKCE&state` |
| 2. Hub (sees its cookie) issues a one-time credential, redirects back | mint **swap token** → `red/sync?swap=…` | issue **authorization code** → `red/cb?code=…&state=…` |
| 3. Spoke **server** redeems it for a session | `POST hub/api/auth/exchange {swap}` → token | `POST hub/token {code, verifier}` → token |
| 4. Spoke sets its own cookie via `setSessionCookie` | ✓ | ✓ (identical — same cookie) |

Equivalences: **swap token ≈ authorization code**, **`/exchange` ≈ `/token`**, **callback allowlist ≈
`redirect_uri` registry**. What the standard one buys:

- **`state`** (CSRF) + **PKCE** (code interception) are built in — the swap flow has neither (root of B1/B4).
- The code is **bound to `client_id` + `redirect_uri`** by the protocol → fixes **B4** (swap-not-bound) for free.
- **Delete** the bespoke `sync` / `exchange` / swap-mint code; **reuse** the OAuth provider's machinery →
  **one** cross-domain mechanism for first-party *and* third-party, instead of two maintained in parallel
  (×N color domains).

It is **not** fewer steps. If the only goal were fewer hops, that's #2 (remove the re-bounce). OIDC's payoff
is correctness + one mechanism, and it's only worth it *when the OAuth provider exists* — hence "at the
migration."

---

## Latency: unification is login-only, not per-request

Unifying the paths (#4) adds latency **only at the login moment**, once. It adds **zero** per-request cost.
After the cookie exists, every authorized request resolves identically regardless of how the cookie was
minted (`getServerAuthSession`): read cookie → verify ES256 **locally** → read shared Redis → hub **only on
a cold miss**. Nothing in that path knows or cares whether the cookie came from a direct hub `Set-Cookie`
(`civitai.com` today) or a swap/auth-code exchange (`civitai.red`). The cookie is byte-for-byte the same
thin token. So routing `civitai.com` through the exchange path costs it one extra redirect + one
back-channel call **at login only** (plus occasionally on rolling refresh); steady-state request latency is
unchanged.

In short: you pay once at the door, not on every request inside.

---

## Recommended sequencing

1. **Now (before prod):** harden + slim the swap bridge — it's the long-term mechanism until the migration.
   - **B1** — replace the hub's `origin.includes('civitai')` redirect check with an exact eTLD+1 allowlist.
   - **B4** — bind the swap token to the redeeming spoke origin (put it in the claims, check at `/exchange`).
   - **Fail closed** when `REDIS_SYS_URL` is absent (today `consumeSwapToken` returns success → replay open).
   - **#2** — remove the redundant re-bounce (mint swap at hub login-completion → straight to spoke `/sync?swap=`).
2. **Defer** the OAuth-provider migration — safe (cookies survive).
3. **At the migration:** adopt the OIDC auth-code bridge (#3) and **unify** the two paths (#4) in one move,
   onto the hardened standard path. Steps live in
   [plans/oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) §I.

What **doesn't** change at any step: the shared `.civitai.com` cookie for the subdomain family, the thin
ES256 token, the signing `kid`, and the shared-Redis per-request resolution. The simplification only touches
*how a cross-root color domain bootstraps its local cookie*.
