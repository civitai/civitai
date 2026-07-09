# OAuth-First-Party Migration — Session Handoff

**Date:** 2026-06-19 · **Branch:** `feat/oauth-first-party` · **Worktree:** `C:/work/civitai-oauth`
**Read with:** [oauth-first-party-migration-plan.md](./oauth-first-party-migration-plan.md) (phased plan + code-reduction ledger) and [oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) (the actionable §A–§I checklist; **§D.x** holds the carried-forward security requirements).

> **Process rule (non-negotiable):** do NOT `git commit` or `git push` without explicit per-instance approval. Everything below is **uncommitted** in the worktree by design — the user does staged commits at the end.

> **Shipping-status correction (2026-06-21):** NOTHING in this monorepo worktree has shipped — it has not been merged to `main` or deployed. So the plan's production-safety machinery — the **30-day dual-run window, the side-by-side swap-vs-auth-code requirement, and the §F "proxy the old routes during deprecation" step — does NOT apply to this branch's code.** There are no live users of it to protect. Superseded code is therefore **deleted outright** as its in-branch replacement lands, not preserved and dual-run. The ONLY surviving constraint is **branch coherence**: don't delete X before its replacement exists *in the branch* (deleting it would just break the worktree, not production). The cookie/`kid` invariant still holds for whenever this *does* ship.

---

## TL;DR — where we are

The migration turns the SvelteKit hub (`apps/auth`, auth.civitai.com) into a real OAuth 2.0 / OIDC provider so first-party cross-domain login and third-party API auth ride ONE mechanism (auth-code + PKCE → thin `civ-token` cookie via BFF). It must net-**reduce** code (retires the bespoke swap-token bridge). Phases:

- **Phase 0** ✅ — spoke open-redirect hardening + decision gate (ratified: OAuth for 1st **and** 3rd party).
- **Phase 1 §A** ✅ — shared-code extraction.
- **Phase 1 §B+§C** ✅ — OAuth core libs ported into the hub (Prisma→Kysely) + parity tests + deps.
- **Phase 1 §D** ✅ — the 9 protocol `+server.ts` endpoints + discovery, built & reviewed (2026-06-19). Typecheck clean, 134 hub + 130 pkg tests pass. The 5 §D.x security requirements are enforced; the two resolved design decisions are applied. 4-agent review (clean-eyes / OAuth-standards / parity / SvelteKit) found no blockers.
- **Phase 1 §E** ✅ — consent (`login/oauth/authorize`) + device-verify (`login/oauth/device`) Svelte pages (buzz spend-limit at consent still a fast-follow).
- **Phase 1 §F/§H** ✅ — old main-app provider deleted outright (no proxy needed — unshipped; see §F note in the checklist).
- **Phase 2** ✅ — first-party trusted clients resolved **by origin** against a DB registry (`apps/auth/.../oauth/first-party.ts`). The trusted login hosts live in the **`TrustedSpokeDomain`** table (bare host, no scheme/port; `includeSubdomains` for wildcard), cached in-memory ~60s. The hub never trusts a bare `client_id` slug — it takes the request's `redirect_uri` **origin**, checks the host against the registry (exact / subdomain-wildcard / dev-loopback), and synthesizes a per-origin client with an **exact** callback. So `civitaic.com` (preview) can be a single wildcard row covering ephemeral `pr-NNNN.civitaic.com` URLs, and `localhost` can be a row so a local spoke authorizes against the real hub. `AUTH_SPOKE_ORIGINS` is **gone** (replaced by the table). Consent skipped for these; the model resolves them through `firstPartyClientForOrigin` (no generic `OauthClient` row needed). **Seed SQL below.**
- **Phase 3** ✅ — first-party BFF flow. Hub: dedicated `/api/auth/oauth/session` exchange (validates code + PKCE, mints a civ-token **session**, never an API token; security-reviewed, no blockers; atomic single-use code consume). Spoke (main app): `/api/auth/authorize` (initiate + PKCE) and `/api/auth/callback` (verify state → exchange → `setSessionCookie`), replacing `sync.ts`; the `useDomainSync` trigger now points at the auth-code flow.
- **Swap bridge DELETED** ✅ — `src/pages/api/auth/sync.ts`, hub `sync`/`exchange` routes, `createExchangeClient`, `mintSwapToken`/`verifySwapToken`/`consumeSwapToken` (+ `AUTH_SWAP_MAX_AGE`) and all swap tests are gone. `SYNC_PARAM` / `syncAccount` / `useDomainSync` are **kept** — they're the cross-domain *trigger*, repurposed to initiate the auth-code flow. `AUTH_SPOKE_ORIGINS` is **RETIRED** — no code reads it; the trusted-host registry is the `TrustedSpokeDomain` DB table (`apps/auth/src/lib/server/oauth/first-party.ts` + `packages/civitai-auth/src/trusted-domains.ts`). All three projects green: main-app `tsc` clean, hub 0 errors + 121 tests, pkg 116 tests.
- **Phase 4** ✅ — login unified (2026-06-22). Both login-entry builders — `buildHubLoginRedirect` ([src/server/auth/login-redirect.ts](../../src/server/auth/login-redirect.ts)) and `hubLoginEntryUrl` ([src/utils/auth-helpers.ts](../../src/utils/auth-helpers.ts)) — now land EVERY color on `${origin}/api/auth/authorize` (kept the hub `/login` entry, so `prompt`/`select_account`/`error`/`reason` still pass through). Same-site `.com` mints its own cookie via the bridge instead of depending on the shared `.civitai.com` cookie; `.com` and `.red` use identical login code. **Also fixed a Phase-3 regression:** both builders still wrapped cross-site landings in the deleted `/api/auth/sync` (a string literal, so typecheck didn't catch it) → cross-site login was runtime-broken; now corrected. Main-app `tsc` clean, `login-redirect` 7 tests pass.
- **Phase 5 (remaining)** ⬜ — first-party-flow telemetry only. No swap dual-run window applies (nothing shipped); the swap surface is already deleted. (Stale comments still mention `/api/auth/sync` in a few files — `popup-done.tsx`, `sync-account.ts`, `constants.ts`, `AccountProvider.tsx` — cosmetic, safe to tidy anytime.)

---

## What's DONE (uncommitted in this worktree)

### §A — shared extraction + a tooling fix
- `@civitai/auth/token-scope` (`packages/civitai-auth/src/token-scope.ts`) — the `TokenScope` bitmask/labels/presets, client-safe constants. Main-app shim: `src/shared/constants/token-scope.constants.ts` re-exports it.
- `@civitai/auth/secret-hash` (`packages/civitai-auth/src/secret-hash.ts`) — `generateKey` + `generateSecretHash` (`SHA512(key + NEXTAUTH_SECRET)`). **Now throws if `NEXTAUTH_SECRET` is unset** (was silently `…+"undefined"` — a review finding). Main-app shim: `src/server/utils/key-generator.ts` re-exports it (keeps `encryptText`/`decryptText`).
- Subpath exports added to `packages/civitai-auth/package.json` (`./token-scope`, `./secret-hash`).
- **Tooling:** `package.json` got `pnpm.overrides: { vite: "6.4.1" }`. Why: during env churn, `@vitest/browser-playwright` pulled `vite@7` (ESM-only) into the tree, and `vitest@4.0.18`'s **CJS** config loader `require()`s vite → `ERR_REQUIRE_ESM`, which broke the **whole** test suite (vite 7 dropped the CJS entry; vite 6 keeps it). Pinning to 6.4.1 fixes it and is verified safe for the hub's SvelteKit build (`@sveltejs/vite-plugin-svelte@6.2.4` accepts `vite ^6.3.0 || ^7`, `@sveltejs/kit@2.65` accepts vite 6). If you ever drop the override, the CJS `@civitai/auth` package tests break again.

### §B+§C — OAuth core libs → `apps/auth/src/lib/server/oauth/`
All 8 libs ported; the two DB-touching ones rewritten Prisma→Kysely against `@civitai/db-schema/kysely`'s `DB`:
| File | Notes |
|---|---|
| `constants.ts`, `errors.ts`, `audit-log.ts`, `server.ts` | verbatim (dropped audit-log's unused `dbWrite`) |
| `redirect-uri.ts` | `redirectUriMatches` (exact + RFC 8252 loopback port flex) |
| `scope.ts` | `hasScope`/`scopeToString`/`stringToScope` (bitmask ↔ decimal-string) |
| `redis-atomic.ts` | `hSetWithTTL` (atomic HSET+HPEXPIRE — no-TTL-code guard preserved) |
| `oidc-nonce.ts` | redis via hub `getRedis()`; degrades to "id_token omits nonce" |
| `rate-limit.ts` | **reuses** the hub's existing `checkRateLimit` (no forked limiter) |
| `token-helpers.ts` | `db.insertInto('ApiKey')` — UserRead baseline + `civitai_` prefix + 1h/30d TTLs |
| **`model.ts`** | the @node-oauth model — every `prisma.*` → Kysely; timing-safe secret compare (+ length guard), origin allowlist, PKCE code store, cascade revoke |
- Deps added to `apps/auth/package.json`: `@node-oauth/oauth2-server@^5.3.0`, `msgpackr@^1.11.5`.
- Also fixed a **pre-existing** (not ours) `apps/auth/src/lib/server/db/db.ts` `DATABASE_URL` undefined-guard so `svelte-check` is green.

**The load-bearing invariant:** the hash/scope/TTL/token-prefix are the SHARED definitions, so a token the hub mints validates in the main app's existing bearer path **with no main-app change**. Do not fork them.

### Verification (re-run any time)
```bash
cd C:/work/civitai-oauth/apps/auth && pnpm run typecheck   # svelte-check: 0 errors
cd C:/work/civitai-oauth/apps/auth && pnpm exec vitest run # 134 tests (incl. 28 OAuth parity)
cd C:/work/civitai-oauth/packages/civitai-auth && pnpm exec vitest run # 130 tests
```
(If a fresh worktree: `pnpm install`, `pnpm run db:generate`, `git submodule update --init --recursive` — the `event-engine-common` submodule must be present or typecheck fails.)

---

## What's NEXT — §D (protocol endpoints)

Build 9 `+server.ts` handlers wiring the ported model to SvelteKit (see checklist §D for the list: `/authorize`, `/token`, `/userinfo`, `/revoke`, `device*`, `/.well-known/openid-configuration`). Each: build the library's Request/Response from SvelteKit `request`, preserve CORS + rate-limit + audit. Token grant must mint the OIDC `id_token` via the hub signer's `mintIdToken()`.

### ⚠️ Security requirements that MUST be enforced in §D (from the 3-reviewer §B audit — see checklist **§D.x**)
The library/model do NOT enforce these alone; the main app enforces each at its endpoints today — **port that behavior**:
1. **PKCE required + S256-only on `/authorize`** — the library only *verifies* a stored challenge, never *requires* one. Port [src/pages/api/auth/oauth/authorize.ts:91-101](../../src/pages/api/auth/oauth/authorize.ts#L91-L101). Never set `enablePlainPKCE:true`.
2. **Refresh-grant scope** — scope is a bitmask-as-decimal-string; the library's string-`.includes()` subset check is meaningless for it. Don't forward a `scope` param on refresh (or bitmask-validate yourself).
3. **CORS origin-echo must re-validate** against `allowedOrigins`; never reflect an arbitrary Origin.
4. **`/revoke`** — RFC 7009 always-200, session-or-client-secret auth.
5. **OIDC** — gate `nonce`/`auth_time`/profile claims on `UserRead`; `consumeOidcContext` exactly once; make `storeOidcContext` atomic (reuse `hSetWithTTL`).

### Two OPEN DESIGN DECISIONS (match the main app today; confirm before cutover)
- **Refresh cascade scope** — `revokeToken` deletes *all* a (user, client)'s access tokens, so refreshing one authorization nukes a second concurrent one. Keep "one live session per (user, client)", or scope to the rotated token's lineage? (No refresh-reuse-detection either.)
- **`client_credentials` grant** — `getUserFromClient` mints a token *as the client owner's user*. Keep, or omit from registered clients' grants to shrink surface?

---

## Phase 2–5 (later)
Trusted first-party `OauthClient` per spoke origin (consent skipped, mints a *session* not a browser-held token), spoke `/authorize`+`/callback` replacing `src/pages/api/auth/sync.ts`'s two roles, unify same-site `.com` onto the same path, then dual-run and delete the swap bridge + `mintSwapToken`/`verifySwapToken`/`consumeSwapToken`. **Never change cookie `name`/`kid` during the window — that's what keeps users logged in.** See checklist §I for the bridge-equivalence map.

---

## TrustedSpokeDomain — registry + seed SQL (apply manually)

The migration `20260622180000_add_trusted_spoke_domain` creates the table; it ships **empty**. Seed it per environment with the hosts that environment actually serves (these are the values of prod's `SERVER_DOMAIN_<COLOR>` / `_ALIASES`, minus scheme/port). One row per host; set `includeSubdomains = true` ONLY for the preview domain.

```sql
-- Prod color domains — EXACT host match. Mirror SERVER_DOMAIN_GREEN/BLUE/RED (+ _ALIASES) for the env.
-- (Fill in any additional aliases / the real blue host; .com + .red are the known ones.)
INSERT INTO "TrustedSpokeDomain" ("domain", "includeSubdomains", "label") VALUES
  ('civitai.com', false, 'green (prod)'),
  ('civitai.red', false, 'red (prod)')
ON CONFLICT ("domain") DO NOTHING;

-- Staging/preview — WILDCARD: auto-deploy mints a unique per-PR host (e.g. pr-2468.civitaic.com)
-- that can't be pre-registered, so trust the whole zone.
INSERT INTO "TrustedSpokeDomain" ("domain", "includeSubdomains", "label") VALUES
  ('civitaic.com', true, 'PR previews (auto-deploy)')
ON CONFLICT ("domain") DO NOTHING;

-- Local dev against the REAL hub — optional. (The hub also auto-trusts loopback when IT runs in dev,
-- so this row is only needed to authorize localhost against a deployed auth.civitai.com.)
-- INSERT INTO "TrustedSpokeDomain" ("domain", "includeSubdomains", "label") VALUES
--   ('localhost', false, 'local dev') ON CONFLICT ("domain") DO NOTHING;
```

Matching rules (`first-party.ts`): a host is trusted if it equals a row's `domain`, OR (`includeSubdomains`) ends with `.<domain>`, OR (dev only) is `localhost`/`127.0.0.1`. Edits take effect within the ~60s cache window. On a DB error the loader serves the last good list (or empty → fail-closed: first-party login denied during a cold outage).

## Related but SEPARATE: the test-site redirect loop
The auth.civitai.com → test-auth.civitai.com redirect loop ("no cookies on test-auth") is a **`monorepo-bootstrap`-branch** problem (the deployed test sites), NOT this OAuth worktree. Prime suspect: `isSecureCookie()` (`packages/civitai-auth/src/cookies.ts`) evaluating **false** on the hub → the session cookie loses its `__Secure-` prefix AND its `.civitai.com` Domain → host-only `civ-token` the spoke can't read. Root cause is the `process.env.NEXT_PUBLIC_BASE_URL ?? process.env.AUTH_JWT_ISSUER` precedence (a `??` doesn't fall back on an empty string; the hub also has no `NEXT_PUBLIC_BASE_URL`). Track that fix on `monorepo-bootstrap`, not here.

---

## Key file map
- Plan/checklist: `docs/auth/oauth-first-party-migration-plan.md`, `docs/auth/oauth-provider-implementation-checklist.md`
- Review findings + action checklist: `docs/auth/oauth-review-findings-2026-06-22.md` (5-agent review; no blockers; Checklist A = do-without-input, Checklist B = needs-decision)
- Ported libs: `apps/auth/src/lib/server/oauth/*` (+ `__tests__/`)
- Shared package: `packages/civitai-auth/src/{token-scope,secret-hash}.ts`
- Originals (compare for parity): `src/server/oauth/*`, `src/server/utils/key-generator.ts`
- Hub infra the libs use: `apps/auth/src/lib/server/db/db.ts` (Kysely), `apps/auth/src/lib/server/redis.ts` (`getRedis`), `apps/auth/src/lib/server/auth/rate-limit.ts`
