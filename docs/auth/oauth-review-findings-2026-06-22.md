# OAuth-First-Party Migration — Multi-Agent Review Findings & Action Checklist

**Date:** 2026-06-22 · **Branch:** `feat/oauth-first-party` · **Scope:** the full migration diff (hub `apps/auth`, spoke `src/`, shared `packages/civitai-auth`) — everything uncommitted vs `HEAD`.

**Review method:** five independent read-only reviewers at varying context levels, each instructed to read the code closely (trace flows, no assumptions, cite `file:line`) and to surface simplifications that **preserve** designed functionality:

1. **Clean-eyes** — zero context, code-on-its-own-merits.
2. **OAuth/OIDC security invariants** — medium context (the carried-forward security requirements + first-party trust gates).
3. **Functionality preservation** — full context; traced every flow incl. impersonation & multi-account.
4. **Cross-app integration** — the seams between the two apps + package.
5. **Simplification hunter** — full context, explicit simplify-without-regressing mandate.

---

## Verdict

**No blockers. Ship-safe. All designed functionality preserved** — cross-validated by all five:

- **Security:** all third-party OAuth invariants (PKCE-required/S256, refresh no-scope-forward, CORS origin re-validation, RFC 7009 `/revoke`, OIDC claim gating, app-block reject, single-use atomic auth codes) and the first-party BFF gates (first-party-only session mint, code↔client binding, PKCE verify, consume-before-mint, CSRF state, httpOnly verifier) HOLD at cited `file:line`. No demonstrated bypass.
- **Functionality:** third-party OAuth + device flow, first-party `.red` and `.com` login, **moderator impersonation**, **multi-account / account switching**, rolling refresh, legacy next-auth cookie verification, and the `SYNC_PARAM` cross-domain trigger all trace WORKS. Impersonation & switching live in files the migration did not touch.
- **Integration:** all 8 cross-app contracts match byte-for-byte on both sides.
- **Simplicity:** the design is at a good balance (diff is net ≈ −4,043 LOC); remaining wins are small and safe.

### Resolved during synthesis (not a real issue)
- **Dangling `createExchangeClient` export** (raised by the security reviewer) — **FALSE ALARM.** The agent read the `HEAD` version (nothing is committed, so `git show HEAD:` shows the pre-deletion file). The working tree has **zero** references to `createExchangeClient`/`exchange-client` (verified), which is why package `tsc` + 116 tests pass.

---

## Findings worth acting on (ranked)

> Most "medium" findings are **parity-carried** (present in the pre-migration code too), i.e. not regressions — but worth tightening for a reusable foundation. Each is tagged.

| # | Finding | Severity | Regression? | Where |
|---|---|---|---|---|
| F1 | `id_token` is minted on **every** `authorization_code` grant (UserRead is force-added, so the gate is always true) even when the client never requested `openid`/`nonce`. Not a hole; diverges from OIDC. | Medium | No (parity) | `apps/auth/src/routes/api/auth/oauth/token/+server.ts` (~L101-117) |
| F2 | `validateScope` defaults a missing `allowedScopes` to `TokenScope.Full` (fail-open). Unreachable today (`OauthClient.allowedScopes` is `NOT NULL`), so it's dead defensive code — but `?? UserRead` would be safer. | Low | No (parity) | `apps/auth/src/lib/server/oauth/model.ts` (validateScope) |
| F3 | Consent **scope integrity**: the consent screen forwards `scope` in a hidden field, so a tampered POST can approve a scope different from what was *displayed* (still bounded by the client's ceiling → no over-grant, a UI-integrity gap). Also `existingConsent.scope !== requestedScope` re-prompts on any scope change instead of honoring "remember" for subsets via `hasScope`. | Medium (integrity) | No (parity) | `apps/auth/src/routes/api/auth/oauth/authorize/+server.ts` (~L103-134) |
| F4 | **Alias-host login**: the spoke derives `client_id`/`redirect_uri` from the **color primary**, not the alias actually visited — so first-party login only works on primary hosts. | Low | No (parity w/ old swap flow) | `src/server/auth/oauth-bridge.ts` `resolveSelfOrigin` |
| F5 | **Operational (highest real risk):** `AUTH_SPOKE_ORIGINS` must list each color's **primary** origin or that color's login fails closed (`invalid_client`). Nothing validates this at boot. | Medium (ops) | n/a | hub env / `first-party.ts` registry |
| F6 | OIDC nonce write is a non-atomic `hSet` + `hExpire` (a crash between leaves a no-TTL nonce field). The auth-code store is already atomic via `hSetWithTTL`. | Low | No (parity) | `apps/auth/src/lib/server/oauth/oidc-nonce.ts` (~L25-26) |
| F7 | `getClientAddress()` is the IP key for `/token` + `/revoke` rate-limits; requires correct trusted-proxy adapter config (`ADDRESS_HEADER`/`XFF_DEPTH`) or it's spoofable. Limiter is fail-open on Redis error. | Low (ops) | n/a | hub adapter config |
| F8 | Device `user_code` lookup normalizes case (`toUpperCase`) but not the `XXXX-XXXX` hyphen/whitespace — a user typing `abcd1234` fails. | Low | No (parity) | `device-info` / `device-approve` `+server.ts` |
| F9 | `/token` post-success fallback client re-query (`if (!attached) …`) never runs in practice (getClient always stashes the client). Defense-in-depth, but a dead second DB round-trip. | Nit | No | `apps/auth/src/routes/api/auth/oauth/token/+server.ts` (~L64-77) |

---

## Simplification opportunities (preserve all functionality)

| # | Simplification | Saves | Risk | Touches (preserved?) |
|---|---|---|---|---|
| S1 | **Share `firstPartyClientId` + `FIRST_PARTY_ID_PREFIX` + `SPOKE_CALLBACK_PATH` in `@civitai/auth`** (currently byte-identical duplicates hub+spoke; correctness-critical — divergence silently breaks all cross-domain login). | ~6 LOC + kills drift | Safe | cross-domain login — identical output |
| S2 | **Merge the two login-entry builders** (`buildHubLoginRedirect` + `hubLoginEntryUrl`) into one shared helper — now identical logic post-Phase-4; this is the exact pair that caused the Phase-3 regression when edited in lockstep. | ~25 LOC + kills drift | Needs-care | `.com`/`.red`/add-account — byte-identical URL (guard with `login-redirect` tests; verify `hubLoginUrl` carries `error`+`prompt`) |
| S3 | **`resolveOauthClient(clientId)` helper** — the "DB lookup → else `getFirstPartyClient`" dance is repeated 3× (`getClient`, `getAuthorizationCode`, `authorize`). | ~20 LOC | Needs-care | 3rd-party + first-party resolution — the 3 sites select different columns; resolver must cover all |
| S4 | **Delete dead `DbFirstPartyClientSource`** (~40 LOC, never instantiated — premature generality). Keep the `FirstPartyClientSource` interface + env impl. | ~40 LOC | Needs-care | nothing live — *confirm DB-clients roadmap isn't imminent* |
| S5 | Extract `scopeLabels(scope)` helper (dup'd: consent page + `device-info`). | ~6 LOC | Safe | scope display only |
| S6 | Extract `resolvePendingDeviceCode(redis, userCode)` helper (dup'd: `device-info` + `device-approve`). | ~20 LOC | Safe | device flow only |
| S7 | Remove dead `sync-redirect` param from `syncAccount` (nothing reads it; pre-existing dead data). | small | Safe | none |
| S8 | Tidy stale `/api/auth/sync` / "swap-token" comments (`popup-done.tsx`, `sync-account.ts`, `@civitai/auth constants.ts`, `AccountProvider.tsx`, hub `cors.ts`). | comments | Safe | none |

### Do NOT cut (load-bearing — confirmed by the simplification reviewer)
- **`/token` ↔ `/session` separation** — the security boundary that prevents a third-party client from minting an account session.
- **Consent page vs device-verify page** — different state machines / POST targets.
- **`SYNC_PARAM` / `syncAccount` / `useDomainSync`** — the cross-domain *trigger* chain the auth-code flow rides.
- **The `FirstPartyClientSource` interface + `EnvFirstPartyClientSource`** — the env→DB seam carries its weight (only `DbFirstPartyClientSource` is speculative).

---

## ✅ Checklist A — DONE 2026-06-22 (behavior-preserving; verified)

Verified after completion: hub `svelte-check` 0 errors + 121 tests, `@civitai/auth` 116 tests, main-app `tsc` clean, `login-redirect` 7/7.

- [x] **S1** — `firstPartyClientId` + `FIRST_PARTY_ID_PREFIX` + `SPOKE_CALLBACK_PATH` now live in `@civitai/auth` (`packages/civitai-auth/src/first-party.ts`); hub + spoke import them (the byte-identical duplicate + drift hazard is gone).
- [x] **S2** — added `error` to `hubLoginUrl`; both builders (`buildHubLoginRedirect`, `hubLoginEntryUrl`) now delegate to one shared `buildHubLoginUrl` (`src/utils/hub-login.ts`). `login-redirect.test.ts` still 7/7.
- [x] **S3** — extracted `resolveClientLite(clientId)` in `model.ts`; `getAuthorizationCode` + `/authorize` route through it. (`getClient` kept its own resolution — it returns the richer Client + runs secret/origin checks.)
- [x] **S5** — `scopeLabels(scope)` in `oauth/scope.ts`; used by the consent page + `device-info`.
- [x] **S6** — `resolvePendingDeviceCode()` + `normalizeUserCode()` in `oauth/device-codes.ts`; used by `device-info` + `device-approve`.
- [x] **S7** — removed the dead `sync-redirect` param from `syncAccount` (+ the one call site). **NOTE:** that call site (`YellowBuzzMigrationNotice`) intended `/user/buzz-dashboard` as the post-sync destination, which the dead param never delivered — left landing on the red root (unchanged behavior). If that destination matters, it's a separate pre-existing fix (see Checklist B follow-up).
- [x] **S8** — swept stale `/api/auth/sync` / "swap-token" comments (`popup-done.tsx`, `@civitai/auth constants.ts`, `AccountProvider.tsx`, hub `cors.ts`).
- [x] **F6** — OIDC nonce write is now atomic via `hSetWithTTL` (parity with the auth-code store).
- [x] **F8** — device `user_code` lookup normalizes (uppercase + strip non-alphanumerics + re-insert hyphen) in `normalizeUserCode`.

## Checklist B — decisions (your `@dev` notes + my `@ai` responses)

- [x] **F1 — DONE.** id_token is now minted only when the `/authorize` request carried a `nonce` (our OIDC marker); plain OAuth clients get just access/refresh tokens. The OIDC context is still consumed once per code grant (single-use). `token/+server.ts`.
@dev - What do you recommend?
@ai: Implemented the recommendation (gate on `nonce`). Caveat noted in the code: a nonce-less OIDC RP won't get an id_token — add an explicit `openid` request marker if that's ever needed.

- [x] **S4 — keep the seam warm.** Per your note, `DbFirstPartyClientSource` stays as-is. No change.

- [x] **F2 — DONE.** Per your note (first-party = Full; third-party default = read): changed the missing-ceiling fallback in `validateScope` from `?? TokenScope.Full` → `?? TokenScope.UserRead`. First-party clients are unaffected (their synthesized client carries an explicit `Full` ceiling); the fallback is unreachable for real DB rows (NOT NULL), so this is purely a safer default.

- [x] **F3(b) — DONE; F3(a) deferred.** "remember" now honors a subset re-request via `hasScope(stored, requested)` — a client asking for ≤ the already-granted scope no longer re-prompts (`authorize/+server.ts`).
@dev - yes - what do you mean by cosmetic here?
@ai: F3(a) = a user could tamper with the hidden `scope` field in their OWN consent POST and approve a scope different from what the screen *displayed*. "Cosmetic" because the issued token is still hard-capped by the client's registered `allowedScopes` ceiling (`validateScope`) — no privilege escalation, no cross-user impact, and the *app* can't do it (it already chose the scope in its `/authorize` request). Only the user can, against their own account, within limits the client already has. So "displayed ≠ granted" is a self-inflicted UI nicety, not a security hole — deferred (airtight would need scope-signing/echo, not worth it).

- [x] **F4 — alias login IS required → resolver updated.** `resolveSelfOrigin` (`src/server/auth/oauth-bridge.ts`) now returns the ACTUAL recognized host's origin instead of collapsing to the color primary, so the whole flow (initiate → hub redirect → httpOnly bridge cookie → callback) stays on the alias the user is actually on. Unrecognized Hosts still fall back to `NEXT_PUBLIC_BASE_URL` (never echoed). **Two per-alias ENV requirements (out of code) to enable a given alias — e.g. `test-auth.civitai.red`:** (1) configure it as a color alias so `getRequestDomainColor` recognizes it, and (2) add `https://<alias>` to the hub's `AUTH_SPOKE_ORIGINS` so the first-party registry mints its client + matches the `redirect_uri`. An alias missing from (2) **fails closed** at the hub (`invalid_client`). ⚠️ **Needs an integration test on the real alias before relying on it.**
@dev - we will need to login using an alias for variations of the site for testing purposes. The first use case will be for test-auth.civitai.red.
@ai: Implemented the resolver change so the flow stays on the alias. Before this, alias-initiated login was actually broken (the httpOnly bridge cookie is host-only on the alias but the callback bounced to the primary, so the PKCE verifier couldn't be read). Remaining to light up `test-auth.civitai.red`: the two env entries above + a smoke test of the full login on that host.

- [x] **F5 — folded.** Per your note: no standalone boot-check; folded into `post-deploy-domain-env-consolidation.md` (under the `AUTH_SPOKE_ORIGINS` consolidation — root fix is deriving the list from `domain.constants`; interim stopgap is the boot assertion).

- [x] **F7 — confirmed set in prod.** Per your note, `ADDRESS_HEADER`/`XFF_DEPTH` are set, so `getClientAddress()` is trustworthy → the IP-keyed `/token`+`/revoke` rate-limits and audit IPs are sound. No change.

- [ ] **F9 — `/token` dead fallback re-query.**
@dev - I don't understand
@ai: After `/token` issues tokens it must set CORS headers, and to do that correctly it needs the client record (public clients get their **exact origin** echoed; confidential/unknown get **wildcard**). Normal path: the OAuth model's `getClient` already stashed the looked-up client on the request during the exchange, so the handler just reads that stash — no extra DB hit. The "fallback re-query" is a SECOND `OauthClient` lookup that runs **only if** that stash is somehow missing — which never happens on a successful exchange (it always went through `getClient`). So it's dead defense-in-depth: a safety net for a hypothetical future where the library stops populating the stash, keeping CORS fail-closed instead of leaking a wildcard. **Recommend KEEP** — it never executes on the happy path (zero runtime cost) and removing it trades a free safety net for ~4 fewer lines. Not worth removing.

---

## Notes
- Nothing is committed (per the migration's process rule); all of the above is against the uncommitted working tree.
- Companion docs: [oauth-migration-handoff.md](./oauth-migration-handoff.md) (phase status), [oauth-provider-implementation-checklist.md](./oauth-provider-implementation-checklist.md) (§A–§I + resolved design decisions).
