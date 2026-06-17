# Auth Hub Cutover — Review Findings (2026-06-17)

**Reviewer:** Claude (Opus 4.8) · **Branch:** `monorepo-bootstrap` · **Scope:** committed branch diff vs `main` + uncommitted working tree

**Goal under review:** Deploy `apps/auth` to **auth.civitai.com** as the central auth hub so that **civitai.com** and **civitai.red** both authenticate through it, replacing NextAuth.

> This doc is a handoff for another session. Findings were produced by four parallel deep reviews (hub / SDK / main-app integration / docs-vs-code) and de-duplicated. Findings **#1, #3, #5** below were re-verified against source directly; the rest are from the sub-reviews and should be spot-checked before acting on them.

---

## TL;DR verdict

**Not ready to deploy.** The cryptographic core is genuinely well-built — do not rewrite it. The problems are (a) a handful of real security bugs and (b) the cutover is not actually finished (NextAuth still live, logout incomplete, OAuth-provider migration not started, no rollback/monitoring plan).

### What's done well (don't "fix" these)
- ES256 pinned in both signer and verifier; signature verified before any claim is trusted.
- `purpose:'swap'` tokens rejected as session tokens and vice-versa (tested both directions).
- Internal-auth token uses constant-time compare and fails closed; dev-login bypass double-gated to `dev && internal`.
- OAuth uses PKCE + `state`; account linking requires a **verified** email.
- CORS echoes an **exact** origin allowlist (never `*`) with credentials; `Vary: Origin` set.
- Main-app server session resolution has **no fail-open on the trust dimension** — bad/missing/expired token always yields no session. Fail-open paths are availability-only (a Redis blip won't log everyone out), which is the correct trade.

---

## BLOCKERS — fix before any deploy

### B1. Open redirect to any host containing the substring "civitai"
- **File:** `apps/auth/src/lib/server/auth/redirect.ts:14`
- `isCivitaiOrigin = (origin) => origin.includes('civitai')` accepts `https://civitai.evil.com`, `https://evil-civitai.com`, `https://civitai.com.attacker.io`.
- Gates the post-login `redirect(302, …)` in the OAuth callback (`login/[provider]/callback/+server.ts`), email-verify landing (`login/email/verify/+server.ts`), and the already-signed-in bounce (`login/+page.server.ts`). The `sync` marker is re-attached, so a malicious origin can also be fed into the swap flow.
- **Fix:** exact eTLD+1 allowlist — `host === 'civitai.com' || host.endsWith('.civitai.com') || host === 'civitai.red' || host.endsWith('.civitai.red')` (plus dev localhost). Not a substring test.
- **Status:** ✅ verified in source. Highest-risk single line in the diff.

### B2. Ban does not revoke active sessions
- `invalidateUserSessions` exists in `packages/civitai-auth/src/session-registry.ts` but **no hub route ever calls it** (grep confirms).
- Banning sets `User.bannedAt` and busts the identity cache, but the existing `civ-token` keeps verifying (signature + expiry + `isRevoked` all pass). Enforcement is delegated to every spoke checking `sessionUser.bannedAt` on every request — the hub provides no revocation.
- **Fix:** wire ban (and the `/api/auth/identity` invalidation path) to call `invalidateUserSessions(userId)`.

### B3. Legacy NextAuth cookie path skips issuer/audience + alg chosen by attacker header
- **File:** `packages/civitai-auth/src/legacy-cookie.ts:24` — `jwtDecrypt(token, key, { clockTolerance: 15 })` checks only `exp`. No `issuer`/`audience`.
- The ES256 path enforces `{ issuer, audience }`; the legacy path does not. If `NEXTAUTH_SECRET` is shared across civitai properties (historically true), a token minted for one audience is accepted by another for the whole migration window.
- Related (`verify.ts:88-113`): the verifier branches on the token's own `alg` header to pick its trust root (ES256 path vs legacy symmetric path) — two trust roots, caller chooses (alg-confusion shape).
- **Fix:** enforce issuer on the legacy decrypt; pin `algorithms: ['ES256']` explicitly on the ES256 path; gate the legacy branch behind an explicit "legacy enabled" flag that gets removed at cutover (not implicitly on `legacySecret` presence).
- **Status:** ✅ verified in source (legacy-cookie.ts).

### B4. Swap token not bound to redeeming spoke; `/exchange` is an unauthenticated, unrate-limited mint oracle; single-use silently disabled without Redis
- Swap token rides in a URL (`?swap=…`) to an allowlisted callback (so it lands in logs/Referer), single-use, 60s TTL — but nothing binds it to the spoke it was minted for. Anyone observing it within the window can redeem it server-to-server for a full session.
- **File:** `apps/auth/src/lib/server/auth/swap.ts:19` — `consumeSwapToken` returns `true` (success) when `REDIS_SYS_URL` is unconfigured, **silently disabling single-use** → full replay.
- `apps/auth/src/routes/api/auth/exchange/+server.ts` — unauthenticated POST, no rate limit.
- **Fix:** put target origin in the swap claims and verify it at `/exchange`; fail **closed** when the single-use store is absent; rate-limit `/exchange`. Consider moving the atomic single-use primitive (`SET NX EX`) into the SDK so each hub doesn't reimplement it.

### B5. Doc/code key-type mismatch — will mis-provision production keys
- `apps/auth/.env.example:20-21` and `docs/auth-hub-launch-checklist.md` say generate **RSA 2048 / RS256** (`openssl genpkey -algorithm RSA … rsa_keygen_bits:2048`).
- Code hardcodes **ES256 / EC P-256** (`packages/civitai-auth/src/sign.ts:26`, `verify.ts:16`). `importPKCS8(rsaKey, 'ES256')` throws — hub can't verify its own tokens.
- **Fix:** change the example + checklist to `openssl ecparam -genkey -name prime256v1 …` and assert the imported key's curve at boot.
- **Status:** ✅ verified in source (.env.example + sign.ts/verify.ts).

---

## MAJOR — the cutover isn't finished

### M1. NextAuth is still fully live
- `src/pages/api/auth/[...nextauth].ts` untouched; `src/server/auth/next-auth-options.ts` still registers credential/OAuth/email providers (incl. `token-login` gated only by `TOKEN_LOGINS`).
- Two systems can mint a session; the legacy one is reachable directly at `/api/auth/signin/*` and its cookie is honored by `getServerAuthSession`'s legacy fallback.
- **Before "hub is the only path":** disable in prod; confirm `TOKEN_LOGINS` unset.

### M2. Logout doesn't clear the device cookie; `logoutAll` is a no-op
- `src/pages/api/auth/logout.ts` clears session cookies (both `civ-token` prefixes, legacy `civitai-token`, orchestrator) but **not** the device cookie (`deviceCookieName()`) that gates seamless multi-account switching. On a shared machine, the "switch back in without re-login" set survives logout.
- `src/components/CivitaiWrapped/AccountProvider.tsx:194` — `logoutAll` is `logout` with a TODO. "Sign out everywhere" does not exist.

### M3. OAuth-*provider* migration into the hub is not started
- `apps/auth/src/lib/server/oauth/` does not exist; no `/api/auth/oauth/*` protocol endpoints, no consent/device Svelte pages, no `.well-known/openid-configuration`. Only the JWKS/signer prereq exists.
- `docs/plans/oauth-provider-implementation-checklist.md` (uncommitted) has four unresolved `@ai:*` design questions awaiting `@dev` input.
- **Decision needed:** is third-party "Sign in with Civitai" in scope for *this* launch? If not, say so explicitly in the docs (main app keeps serving OAuth).

### M4. The uncommitted "drop social login" work is half-done
- Done: `AccountsCard` decoupled (`OAUTH_PROVIDERS` from `@civitai/auth/client`).
- Not done: `IframeHost.tsx` still triggers `LoginModal`; `src/pages/login/index.tsx` still renders `LoginContent`; `src/pages/discord/link-role.tsx` still uses `getProvidersInProcess`/`handleSignIn`/`SocialButton`.
- **Data-loss risk (flagged REQUIRED in the plan):** the `reason` cookie (`ref_login_redirect_reason`, consumed at `src/server/auth/login-side-effects.ts:32`) must be re-homed **before** `/login` becomes a hub redirect, or signup referral attribution silently breaks.
- `prompt=select_account` regression also noted in `docs/plans/drop-main-app-social-login.md`.

---

## Monorepo / base-package boundary concerns (`@civitai/auth`)

The package is a shared base package consumed by both the SvelteKit hub and the Next app, so these matter per the base-package rules (infra-only, external-deps-only, no app business logic):

- **`next-auth` is a hard runtime dependency** (`packages/civitai-auth/package.json`) and the signer contract is coupled to `next-auth/jwt` types, re-exported from the main barrel. App-framework leakage into infra. The browser `./client` entry is clean; the **main entry is not edge-safe** despite headers implying it is.
- **Ships raw `.ts` — no build, no `tsconfig`, no `types` export condition.** Only typechecks transitively through consumers; a consumer with different `moduleResolution` could resolve a different/missing entry.
- **SDK computes cookie *names* but owns no cookie *attributes*** (HttpOnly/SameSite/Domain/Secure) — each consumer hand-writes `Set-Cookie` and can get it wrong independently.
- `packages/civitai-auth/src/cookies.ts` `isSecureCookie()` silently returns `false` (→ unprefixed `civ-token`) if neither `NEXT_PUBLIC_BASE_URL` nor `AUTH_JWT_ISSUER` is set → two spokes compute different cookie names and silently don't see each other's sessions.

---

## Operational gaps (no safe launch without these)

- **Every infra checklist item is unchecked**, and there is **no rollback plan, no existing-session/account migration plan, and no monitoring/alerting**. The cutover doc deliberately *removed* the feature-flag safety net ("the flip-back net is illusory") — so today there is no documented way back if the hub misbehaves in prod.
- Rate-limiter + Turnstile depend on real client IP → require `ORIGIN`/`ADDRESS_HEADER`/`XFF_DEPTH` (unset → limits become global).
- `AUTH_SPOKE_ORIGINS` must be set or cross-domain sync denies all callbacks (`api/auth/sync/+server.ts`).
- **Cross-domain `.com ↔ .red` round trip and cross-domain logout have never been validated end-to-end** — only unit tests + a smoke harness (can't be tested on localhost).
- **Doc rot:** `docs/auth-hub-main-app-changes.md` still describes an abandoned **fat RS256 token** model; the shipped design is **thin ES256**. Mark it superseded so nobody builds the consolidation from it. (Also `thin-session-token-design.md` claims `createSessionClient()` takes no args, but the revocation fix reintroduced `createSessionClient({ isRevoked })` — minor doc/code drift.)

---

## Recommended order of work

1. **B1** open redirect — quick, highest risk.
2. **B2** ban → revocation; **B3** pin issuer + flag-gate legacy path.
3. **B4** bind swap to origin + fail-closed without Redis + rate-limit `/exchange`.
4. **B5** fix `.env.example`/checklist key-gen to EC; mark fat-token doc superseded.
5. Decide **M3** OAuth-provider scope for this launch (changes how much remains).
6. Finish **M2** logout/device-cookie + `logoutAll`; close out **M1** NextAuth *only after* the legacy account-switch strip-ordering risk is handled (`account-switch.ts` is still next-auth-based — deleting next-auth first makes legacy localStorage accounts unredeemable).
7. Write rollback + session-migration + monitoring runbook; run real cross-domain e2e before flipping DNS.

---

## Quick-win candidates (safe, isolated)
- **B1** open-redirect allowlist tightening.
- **B5** `.env.example` + launch-checklist key-gen command (EC, not RSA).
- Mark `docs/auth-hub-main-app-changes.md` superseded.
