# OAuth implementation — multi-agent security review (2026-06-22)

**Method:** four independent read-only review agents with *varying levels of context* (zero / minimal / architecture / full-migration) and different focuses (fresh-eyes security audit, architecture-conformance, token lifecycle + API-auth, cross-domain cookies + spoke integration). Findings below are the deduplicated, adjudicated union. Notably the **zero-context "fresh eyes" agent found the headline issue that the high-context agent rationalized as safe** — the disagreement was resolved by tracing the exploit by hand (it is real).

**Scope:** hub OAuth provider (`apps/auth`), shared `@civitai/auth` package, the Next.js spoke (`src/`), and the same-site `civitai-advertising` spoke.

Severity key: 🔴 high · 🟡 medium · 🔵 low · ⚪ won't-fix/decision.

---

## 🔴 H1 — First-party trust keyed on redirect_uri *origin*, not verified *client identity*  ·  ✅ DONE (2026-06-22)

> **Fixed (identity gating):** `resolveClientLite` now returns an `isFirstParty` flag — `false` whenever an `OauthClient` row exists (a registered/third-party client, **regardless of its redirect origin**), `true` only for the synthesized no-DB-row path. The DB lookup it already did is the discriminator, so no extra calls. `/authorize` (consent-skip) and `/session` (session-mint) now gate on that flag instead of `isFirstPartyOrigin(origin)`, so a third-party that registers a `redirect_uri` at an owned domain still gets the consent screen and only `/token` (scoped) tokens — never a session. Tests added (`model.test.ts`): DB client at a trusted origin → `isFirstParty:false`; synthesized client → `isFirstParty:true`. **Still recommended as belt-and-suspenders (not done here):** #2 reject trusted-origin redirect_uris at registration, #3 (M4) keep `includeSubdomains` to `civitaic.com` + gate dev-loopback behind an explicit env flag.

The intended rule is "only **synthesized** first-party clients (the `firstparty-` namespace, no DB row) skip consent and may mint a session at `/session`." The implementation instead keys on `isFirstPartyOrigin(originOf(redirectUri))`, and two things combine to break the boundary:

1. **Client registration doesn't exclude trusted origins** — `src/server/routers/oauth-client.router.ts` (`create`, any logged-in user) + `src/server/schema/oauth-client.schema.ts` validate `redirectUris` as URLs only. A third-party client may register `redirect_uri = https://<trusted-spoke>/api/auth/callback`.
2. **`/authorize` and `/session` treat that DB client as first-party** because its redirect origin is in `TrustedSpokeDomain`:
   - `apps/auth/src/routes/api/auth/oauth/authorize/+server.ts` — consent **skipped** when `isFirstParty`.
   - `apps/auth/src/routes/api/auth/oauth/session/+server.ts:48` — gate is `isFirstPartyOrigin(originOf(authCode.redirectUri))`; `resolveClientLite(clientId)` happily resolves the **DB** client, `authCode.client.id === clientId` passes (their own UUID), PKCE passes → **`mintUserSession` issues a full civ-token SESSION** instead of a scoped Bearer token.

**Impact:** the `/session`-vs-`/token` boundary the design rests on collapses for any third-party client whose `redirect_uri` sits at a trusted origin. Exploitability is gated by the attacker being able to **receive the code at a trusted host**:
- `civitai.com` / `civitai.red` callbacks are Civitai-controlled → attacker can't read the code (so consent-skip erosion only).
- The **`civitaic.com` `includeSubdomains` wildcard** (ephemeral `*.civitaic.com` previews) is the realistic vector if any such host can be attacker-controlled.
- **dev-loopback** (`first-party.ts` `alwaysTrustHosts: ['localhost','127.0.0.1']`, gated on the bundler `dev` constant) means any `localhost` client mints sessions in a `dev=true` build.

**Fix:** gate first-party treatment on the client being a **synthesized** first-party client (no DB row; `clientId === firstPartyClientId(origin)` via `resolveClientLite`'s first-party branch) at *both* `/authorize` (consent-skip) and `/session` — a DB client must never be first-party even at a trusted origin. Independently: reject `redirect_uri`/`allowedOrigin` under any `TrustedSpokeDomain`/`CIVITAI_OWNED_DOMAINS` at registration; keep `includeSubdomains` to `civitaic.com` only (enforce in the admin write path); gate the dev-loopback on an explicit env flag rather than `dev`.

## 🔴 H2 — `NEXTAUTH_SECRET` is the shared token-hash salt; a skew silently breaks all token auth  ·  OPEN

`packages/civitai-auth/src/secret-hash.ts` derives the stored key as `SHA512(token + NEXTAUTH_SECRET)` for **every API key and OAuth access/refresh token**, on both the hub and the main app (each reads its own `process.env`). The package env schema marks it `.optional()`.

> **Clarification (owner):** `NEXTAUTH_SECRET` was thought of as legacy-only (legacy-cookie users get re-issued a hub cookie). It is **not** legacy-only — it is the *active* token-hash salt. To make it legacy-only, the token-hash salt must first move to a dedicated secret. Until then this is a hard cross-app invariant.

**Impact:** if the hub and main app ever hold different values (independent rotation / deploy skew), every hub-minted token + personal API key fails main-app validation as a plain `null` — no error, no distinguishing signal. The fail-fast guard only catches *unset*, not *mismatched*.

**Fix:** treat as a required shared secret; publish a non-secret fingerprint (`SHA256(secret)[:8]`) on both apps' health/diagnostics and alert on mismatch; log the fingerprint on boot.

## 🟡 M1 — Banned (not deleted) user accepted on the bearer path  ·  ✅ DONE (2026-06-22)

> Fixed: `src/server/auth/bearer-token.ts` now rejects (`return null`) any user with `bannedAt` set, centrally on the bearer/API path (deleted users were already excluded by `getSessionUser`). Mirrors tRPC's `isAuthed` ban check; the session/cookie path still resolves a banned user so the "you're banned" UI works.

`src/server/auth/session-user.ts` (`where: { deletedAt: null }`) + `src/server/auth/bearer-token.ts` resolve a full session for a `bannedAt`-set user. Ban is enforced only downstream (tRPC `isAuthed`, `submit-version.ts`). Any `/api/v1/*` handler that authenticates via bearer and doesn't re-check `bannedAt` serves a banned user's token. **Fix:** reject (or flag) banned/deleted users centrally in `getSessionFromBearerToken`, or a shared assert every bearer REST handler calls.

## 🟡 M2 — No refresh-token reuse detection (public PKCE clients)  ·  OPEN

`apps/auth/src/lib/server/oauth/model.ts` (`revokeToken`/`saveToken`) rotates refresh tokens but a replay of an already-rotated token just misses (`invalid_grant`) with **no family-cascade revoke**. A thief who wins the rotation race once owns the token family silently and indefinitely; the honest client just looks "expired." OAuth 2.1 / RFC 6819 recommend revoking the whole family on reuse. **Fix:** add lineage (`familyId`/`replacedBy`); on a consumed-token replay, cascade-revoke all rows in the family. *Defense-in-depth for third-party clients only — first-party spokes don't use OAuth refresh tokens.* (See review notes for the full write-up.)

## 🟡 M3 — `/session` has no rate limit  ·  ✅ DONE (2026-06-22)

> Fixed: added a `session` bucket to `apps/auth/.../oauth/rate-limit.ts` (**300/min, per-IP**) and wired `checkOAuthRateLimit('session', ip)` into the `/session` endpoint before any redis/crypto/DB work. The limit is a deliberately generous flood-guard because the caller is the spoke *server* (its egress IP), not an end user — well above any single spoke pod's real login throughput.

`apps/auth/src/routes/api/auth/oauth/session/+server.ts` lacks `checkOAuthRateLimit` (every other OAuth endpoint has one). Invalid codes bail cheaply at the Redis `HGET`, so it's not a guessing/amplification hole — the concerns are **consistency** and an unauthenticated **Redis-HGET flood** (reachable directly + via the `civitai.com/api/auth/oauth/session` 308 forwarder). **Caveat:** `/session` is called *server-to-server by the spoke*, so the source IP is the spoke server, not the user — a naïve per-IP limit would throttle a busy spoke. Use a **generous IP threshold** or key on the spoke `client_id`. **Fix:** add `checkOAuthRateLimit('session', …)` with a deliberately chosen key.

## 🟡 M4 — Subdomain-wildcard breadth  ·  OPEN (policy)

`packages/civitai-auth/src/trusted-domains.ts` trusts any `hostname.endsWith('.'+domain)` for an `includeSubdomains` row. If ever enabled on `civitai.com`/`.red`, an XSS/takeover on any `*.civitai.com` subdomain becomes a consent-skipping, session-minting first-party origin. **Fix:** restrict `includeSubdomains` to the ephemeral-preview eTLD+1 (`civitaic.com`) only; enforce in the admin write path.

## 🔵 L1 — Login loop-breaker can false-trigger on a hub blip  ·  ✅ DONE (2026-06-22)

> Fixed: `src/pages/api/auth/authorize.ts` now trips the loop-breaker on **cookie PRESENCE** (`!req.cookies[sessionCookieName()]`) instead of `!getHubSession()`. This is purely local (no verify, no hub fetch), so a cookie that *stuck* is detected regardless of whether the rich-user identity fetch succeeds — a transient hub blip can no longer clear a good cookie. Trade-off: it no longer detects a stale, present-but-invalid cookie (Cause 2), but the suffix-guard already prevents the primary cause and `clearAllSessionCookies` still runs on a genuine didn't-stick.

`src/pages/api/auth/authorize.ts` trips when `POST_LOGIN_MARKER` is present and `getHubSession(req)` is falsy — but `getHubSession` is also null when the *rich-user identity fetch* fails on a cold cache for a brand-new, valid session. A hub blip within the 60s marker window (or a fast add-account reload) would clear a good cookie + show the terminal error. **Fix:** trip only on *local* failure (session cookie absent / fails local signature verify), not on a rich-user fetch failure.

## 🔵 L2 — `/revoke` leaves the `OauthConsent` row  ·  OPEN

`apps/auth/src/routes/api/auth/oauth/revoke/+server.ts` deletes token rows but not the standing `OauthConsent`. After "revoke this app," a re-authorization finds the remembered consent and may skip the consent screen. **Fix:** on whole-app (refresh-token) revocation, also delete the `OauthConsent` for that (user, client).

## 🔵 L3 — Device endpoints rate-limited by attacker-rotatable `client_id`  ·  OPEN

`device/+server.ts` and `device-token/+server.ts` key `checkOAuthRateLimit` on `client_id`; `/token`/`/revoke` correctly key on IP (with a comment that client_id keying lets an attacker rotate for a fresh bucket). Low impact (codes are high-entropy), but the limiter is weak here. **Fix:** key device endpoints on IP.

## 🔵 L4 — Magic-link verification tokens replayable for the full 24h TTL  ·  OPEN (intentional tradeoff)

`apps/auth/src/lib/server/auth/email-tokens.ts` doesn't consume on success (survives email-scanner prefetch). A captured link works repeatedly for 24h. Matches legacy NextAuth. **Fix (optional):** single-use-with-grace or a shorter TTL.

## 🔵 L5 — REST `/api/v1` scope + `blockApiKeys` not centrally enforced  ·  OPEN (discipline)

tRPC defaults unannotated procedures to require `TokenScope.Full` and centrally applies `blockApiKeys`; REST `/api/v1/*` handlers call `getSessionFromBearerToken` directly and must self-enforce scope (and have no `blockApiKeys` equivalent). A new write handler that forgets the scope check accepts any scoped token. **Fix:** shared `requireScope(session, scope)` helper + checklist for `/api/v1` handlers.

## 🔵 L6 — OIDC `id_token` issued on a nonce-only signal  ·  OPEN (interop)

`apps/auth/src/routes/api/auth/oauth/token/+server.ts` keys `id_token` issuance off a stored `nonce`, not an explicit `scope=openid`. Not a session leak (id_token ≠ session), but diverges from the OIDC contract for nonce-less RPs. **Fix:** add an explicit `openid` request marker.

## 🔵 L7 — Catch-all `/api/auth/oauth/[...path]` is a permanent blind forwarder  ·  INFO

`src/pages/api/auth/oauth/[...path].ts` 308-reflects any `/api/auth/oauth/*` path to the hub. It only matches that prefix and the hub re-authorizes every endpoint, so no leak — but a future hub route under that prefix is auto-exposed through `civitai.com`. **Fix (optional):** allowlist known sub-paths to fail closed on new hub routes.

## ⚪ W1 — No `aud` on the civ-token  ·  WON'T FIX (owner decision)

Bridge-minted sessions are fungible across all first-party origins (no audience pinning). **Owner decision:** intentional — the shared `.civitai.com` cookie model wants one fungible token; an `aud` adds nothing. Closed.

## 🔵 Minor — advertising spoke prefix derivation

`civitai-advertising`'s `hub-session.ts` hardcodes the cookie-name prefix off SvelteKit's `dev` flag while the package derives it from `isSecureCookie()` (protocol). Agree today; could drift if that spoke ran dev-over-HTTPS or prod-over-HTTP. Align on `isSecureCookie()`.

---

## Verified solid (multiple agents tried to break these)

PKCE S256-required + re-verified timing-safely at `/session`; **auth-code single-use** via atomic `HDEL` return-count (closes the get-then-delete TOCTOU under concurrent redemption); **alg-confusion** defended (`algorithms: ['ES256']` pinned, never header-inferred; `purpose:'swap'` rejected; legacy JWE behind a kill-switch); token storage random + salted SHA-512, fail-fast on missing secret; timing-safe secret/PKCE compares with length guards (fail closed, not throw); open-redirect defenses (`safePath` rejects `//host` and `/\host`, exact `redirect_uri` match with RFC 8252 loopback-port flexibility only, `Referrer-Policy: no-referrer` on the callback); `/token` strips `scope` on refresh (no escalation); `UserRead` forced on at mint/validate/authorize; `AppBlocksSubmit` correctly excluded from `Full`, bounded by `ALL_SCOPES`, gated by `allowedScopes`, enforced at its one consumer; revocation immediate on `/api/v1` (uncached `ApiKey` lookup); session resolution **fails open to anonymous** on cache/hub-fetch failure — never 500s or wrongly authenticates; bridge cookie HttpOnly + SameSite=Lax + callback-path-scoped + single-use; cross-site spokes cannot emit a cookie for another origin (the suffix-guard); `clearAllSessionCookies` covers both prefixes across host-only/registrable/override scopes.

## Suggested order of work
1. ~~**H1** — close the first-party-identity boundary (synthesized-client gating).~~ ✅ done (identity gating + tests). Follow-ups remain: registration-time rejection of trusted-origin redirect_uris, and M4.
2. **H2** — decision: introduce a dedicated `API_KEY_HASH_SECRET` (shared) so token hashing stops depending on `NEXTAUTH_SECRET`; give Forgejo (`dev-git-access`) its own key; magic-link is hub-internal (fine). Interim: skew fingerprint on the shared hash secret.
3. ~~**M1** — centralize banned-user rejection.~~ ✅ done
4. ~~**L1** + **M3** — loop-breaker false-trigger fix + `/session` rate limit.~~ ✅ done
5. **M2, M4, L2–L7** — as capacity allows.

Remaining for a next pass: **H1** + **H2** (need decisions), then **M2** (refresh reuse detection), **M4** (wildcard policy), and the L-tier cleanups.
