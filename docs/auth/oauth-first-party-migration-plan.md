# First-party SSO → OIDC: concrete migration plan

**Status:** plan (execution-ready sequencing). **Goal:** retire the bespoke swap-token cross-domain
bridge and run **first-party** login on the hub's standard **OIDC authorization-code + PKCE** flow —
while the *result* stays the thin `civ-token` ES256 session cookie (BFF). One login front door for
first-party *and* third-party.

**Builds on (don't duplicate — read these for rationale/granular steps):**
- [first-party-sso-vs-oauth-analysis.md](./first-party-sso-vs-oauth-analysis.md) — why converge.
- [oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) — `§A–§H`
  (provider into the hub) + `§I` (first-party bridge → OIDC). **This doc sequences those; §I is the
  porter's checklist.**
- [auth-login-simplification.md](./auth-login-simplification.md) — swap↔auth-code mapping, latency, cookie safety.

---

## Why now

The swap-token bridge is a private re-implementation of the auth-code flow, and the bugs it generates are
exactly the ones OAuth standardizes away: the multi-host callback-origin bug
([sync.ts](../../src/pages/api/auth/sync.ts) — fixed), the hand-kept `AUTH_SPOKE_ORIGINS` allowlist (≙
`redirect_uri` registry), and the cross-domain cookie/loop class. Each is fixable, but they keep
recurring because we're maintaining bespoke security-sensitive crypto. OIDC replaces it with `state` /
PKCE / exact `redirect_uri` for free.

**Honest scope caveat:** this does **not** fix today's "no cookies on the test site" blocker — that's the
*hub* failing to set a usable `.civitai.com` cookie (config/redeploy), and OIDC's BFF ends in the **same**
cookie set. Migrate for maintainability, not to escape that bug. Fix the hub cookie first.

## End state

```
spoke (not logged in) ─► spoke /authorize redirect (client_id + redirect_uri + state + PKCE)
   ─► hub /authorize (session gate; trusted client ⇒ no consent) ─► back to spoke /api/auth/callback?code&state
   ─► spoke backend POST hub /token (code + PKCE verifier) ─► thin civ-token
   ─► spoke setSessionCookie(...) (UNCHANGED). Steady state = local JWKS verify.
```
No `/api/auth/sync`, no `/api/auth/exchange`, no `mintSwapToken`. `.com` and `.red` both ride this; `.com`
no longer depends on a shared `.civitai.com` cookie at all — it mints its own via the code exchange.

---

## Does it actually reduce code? (the simplification test)

This only counts as simplification if it **nets out smaller** — and it does, **conditional on the OAuth
provider being in scope for third-party developers** (the planned "M3" work). The provider is built and
hardened **once** and serves both; the first-party migration's job is to *delete* the bespoke bridge and
reuse it.

**Deleted — the bespoke swap bridge:**

| Surface | Lines |
|---|---|
| `src/pages/api/auth/sync.ts` | 60 |
| `src/hooks/useDomainSync.tsx` | 23 |
| `src/utils/sync-account.ts` | 59 |
| hub `routes/api/auth/sync/+server.ts` | 50 |
| hub `routes/api/auth/exchange/+server.ts` | 46 |
| `@civitai/auth` `exchange-client.ts` | 31 |
| `@civitai/auth` swap crypto (`mintSwapToken`/`verifySwapToken`/`consumeSwapToken`) + `SYNC_PARAM` | ~60 |
| hub `AUTH_SPOKE_ORIGINS` allowlist + env | ~20 |
| swap tests (`exchange-client.test` 52, `exchange.test` 102, `swap.test` 68, + swap cases in sign/verify) | ~250 |
| **Total deleted** | **~550–600** |

**Added — first-party-specific (reuses the provider's `/authorize` + `/token`):**

| Surface | Lines (est.) |
|---|---|
| spoke `/api/auth/authorize` redirect (initiate) | ~50 |
| spoke `/api/auth/callback` (receive) | ~60 |
| trusted-client registration (config, derived from `domain.constants`) | ~20 |
| **Total added** | **~130** |

**Net first-party ≈ −400 LOC** — and more important than the count, it deletes **bespoke
security-sensitive crypto** (swap mint/verify/consume, the open-redirect/replay surface behind review
blockers B1/B4) in favor of the standard, already-hardened `/authorize` + `/token`.

**The provider is not net-new for this effort:** the ~1,100-LOC OIDC surface (`authorize`, `token`,
`userinfo`, `revoke`, device, discovery, JWKS) already exists **dormant in the main app** and is
*relocated* to the hub for the third-party work — it replaces the equivalent main-app routes (≈ net 0 for
the move) and is not charged to first-party.

### The gate (Phase 0 hard stop)

If the OAuth provider is **NOT** in scope for third-party, this migration is a **net add** — standing up a
provider to retire a ~270-line bridge. In that case **do not migrate**: keep the swap bridge and only
harden its blockers (B1/B4/fail-closed). The simplification claim is *entirely* contingent on the provider
being shared. Decide this **before** Phase 1.

## The load-bearing invariant (read first)

The session cookie is **decoupled** from the bridge. The `/token` exchange returns the *same* civ-token the
swap exchange did, and the *same* `setSessionCookie()` is called. Users stay logged in across the migration
**iff**:
- The signing **`kid`** and the cookie **name / domain / secure** logic are **unchanged** (they live in
  `@civitai/auth`'s `sessionCookieName()` / `isSecureCookie()` / the hub signer — do **not** fork them here).
- Swap **and** auth-code bridges run **side-by-side** through the whole deploy window — no flag-flip that
  deletes swap before auth-code is serving.

Violating either logs users out. Everything below preserves them.

---

## Phases

### Phase 0 — decisions + prerequisites (gate) — STARTED
- [x] Decision to proceed taken (migration greenlit) → the analysis open-questions are resolved in the
  affirmative for execution: OAuth-provider-into-hub **in scope**; first-party = **trusted OIDC clients,
  consent skipped**; result is the **cookie, not a browser-held token**; signer = **ES256** (docs rot only).
  *(Team to formally ratify; this is the working assumption the plan executes against.)*
- [x] **Live swap-bridge blockers** — status verified against the code, not just the review:
  - [x] **B1 (hub)** — `apps/auth/.../redirect.ts` `isCivitaiOrigin` already does an exact eTLD+1 host check. ✓
  - [x] **B1 (spoke)** — *was still live:* `src/pages/login/index.tsx`'s `isSafeCrossOriginRedirect` used
    `origin.includes('civitai')`. **Fixed this branch** → exact-host match against `getAllServerHosts()`
    (the deploy's own color-map primaries + aliases; rejects `civitai.evil.com` / `evil-civitai.com` /
    `civitai.com.attacker.io`). Typecheck clean.
  - [x] **B4 fail-closed** — `apps/auth/.../swap.ts` `consumeSwapToken` already returns `false` when
    `REDIS_SYS_URL` is unset and on any redis error (deny over replay). ✓
  - [~] **B4 origin-binding** — **deferred to this migration itself** (per the cutover review): a
    self-asserted spoke origin is cosmetic since the swap value is observable in the callback URL; real
    binding needs client auth, which the OIDC `/token` exchange provides. Closed by Phase 3, not patched here.
- **Done when:** decisions ratified; the spoke open-redirect fix lands; no other live swap blocker remains.

### Phase 1 — make the hub a real OIDC provider (`§A–§H`) — the big rock
The provider exists **dormant in the main app** (`src/pages/api/auth/oauth/{authorize,token,userinfo,revoke,device*}.ts`,
`jwks.ts`, `.well-known/openid-configuration.ts`); the hub has only the JWKS endpoint. Move it in:
- [ ] `§A` extract shared code (`generateSecretHash`, `TokenScope`) so the hub can import it (blocks the rest).
- [ ] `§B–§D` port the OAuth core + `/authorize`, `/token`, `/userinfo`, `/revoke`, device endpoints into
  `apps/auth/src/routes/...`; auth-code = SHA256-hashed code in Redis w/ PKCE challenge, ~10-min TTL.
- [ ] `§E` consent + device approval pages (skipped for trusted clients, but built for third parties).
- [ ] `§F` redirect/proxy the old main-app routes; `§H` cutover; discovery doc + JWKS already at the hub.
- **Done when:** a third-party test client completes auth-code+PKCE end-to-end against the hub, and
  `/.well-known/openid-configuration` + JWKS are served from `auth.civitai.com`.

### Phase 2 — register first-party color domains as trusted clients
- [ ] One `OauthClient` per live spoke origin (confirm the set from
  [domain.constants.ts](../../src/shared/constants/domain.constants.ts)): `civitai.com`, `civitai.red`,
  green/blue, **and test hosts** (`test-auth.civitai.*`).
  - [ ] `redirect_uri` = each spoke's `https://<host>/api/auth/callback`, **exact-match** (the guarantee
    `AUTH_SPOKE_ORIGINS` gives today — and derive this list from `domain.constants` so it can't drift).
  - [ ] **Trusted flag ⇒ consent skipped.**
  - [ ] Scope = full session identity (a "session" grant or `Full`-scope trusted client) → result is the
    civ-token cookie, **never** a browser-held access token.
- **Done when:** each spoke origin resolves to a trusted client with its exact callback registered.

### Phase 3 — spoke auth-code bridge (replace `sync.ts`)
Per the `§I` equivalence map:
- [ ] **`/authorize` redirect (initiate)** — replaces `sync.ts` initiate: build hub `/authorize?client_id&
  redirect_uri&state&code_challenge`; stash PKCE `verifier` + `state` in a short-lived httpOnly cookie. Use
  `getRequestBaseUrl(req)` / color primary for `redirect_uri` (the multi-host fix already landed for sync).
- [ ] **`/api/auth/callback` (receive)** — replaces `sync.ts?swap=`: verify `state`, server-to-server
  `POST hub /token` with `code` + `verifier`, then the **existing** `setSessionCookie(res, token, { host })`.
- [ ] Reuse a `@civitai/auth` token-exchange client (mirror `createExchangeClient`'s shape) so app code
  never hand-rolls the `/token` call.
- **Done when:** `.red` and a test host establish a session via auth-code with **zero** swap hits, cookie
  format identical to today.

### Phase 4 — unify same-site `.com` onto the same path
- [ ] Point same-registrable-domain login (`civitai.com`, `test-auth.civitai.com`) at the same `/authorize`
  → `/callback`. This is the path-unification from `auth-login-simplification.md` #4: one login path, no
  per-request cost, and `.com` stops depending on the shared `.civitai.com` cookie (kills that loop class).
- **Done when:** `.com` and `.red` use identical login code; the same-domain shared-cookie path is unused.

### Phase 5 — dual-run, observe, delete
- [ ] Ship Phases 3–4 **alongside** the live swap bridge. Add swap-hit telemetry.
- [ ] Once swap hits ≈ 0 for **one full session/cookie lifetime** (30d) past cutover, delete in order:
  `src/pages/api/auth/sync.ts`; hub `routes/api/auth/sync/+server.ts` + `exchange/+server.ts`;
  `createExchangeClient` + `mintSwapToken`/`verifySwapToken`/`consumeSwapToken` from `@civitai/auth` + hub;
  retire `SYNC_PARAM` / `useDomainSync` if unreferenced; retire `AUTH_SPOKE_ORIGINS` (now `redirect_uri`).
- [ ] **Never** change cookie `name`/`kid` during this window.
- **Done when:** swap surface deleted, `grep -r "swap\|/api/auth/sync\|/api/auth/exchange" src apps/auth` is
  clean, all sessions intact.

---

## Acceptance criteria (whole migration)
- A logged-out user on **any** spoke/alias (`.com`, `.red`, `test-auth.*`) completes login via auth-code +
  PKCE and lands authenticated, with the **same** `civ-token` cookie shape as today.
- No `/api/auth/sync` / `/api/auth/exchange` / swap-token code remains.
- `redirect_uri` registry derives from `domain.constants` (single source of truth; no parallel allowlist).
- Existing sessions survive every phase (no forced re-login).
- One security-review surface for first-party + third-party.

## Rollback
- Phases 1–4 are **additive** (auth-code runs beside swap) → rollback = stop routing to `/authorize`, swap
  still serves. No data migration.
- Phase 5 (deletes) is the only one-way step — gate it strictly on swap-hits ≈ 0.

## Effort & sequencing
- Phase 1 (`§A–§H`) is the bulk — a real provider port; it's the deferred "M3" work. Phases 2–4 are small
  once Phase 1 lands (the hub already issues codes; the spoke change is ~2 endpoints).
- **Order is fixed:** Phase 1 gates everything; Phase 5 trails by a full cookie lifetime.
- Until Phase 5, the swap bridge is production and its blockers (Phase 0) must stay fixed.
