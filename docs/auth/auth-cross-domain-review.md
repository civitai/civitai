# Cross-domain swap-token exchange — review synthesis

**Date:** 2026-06-15 · **Branch:** `monorepo-bootstrap` · **Scope:** the hub-native cross-domain exchange
(commits `f065e9db06` package · `b0be1751a2` hub · `b68ee2ce9d` spoke/client).

## Method

Three subagents reviewed the same change at **different context levels**:

- **Full** — given both the spec (`auth-hub-spoke-overview.md`) and the cutover doc's cross-domain section.
- **Partial** — given only the high-level spec.
- **Cold** — no docs; adversarial, code-only.

## What the differing context produced

All three **independently converged** on the same top-three security issues — which, given they started from
different knowledge, strongly suggests those are real. The context level shifted *emphasis*, not conclusions:

- **Full context** confirmed fidelity to the intended flow and additionally caught the hub reflecting an
  unvalidated `returnUrl` (a contract-ownership point only visible if you know the hub is meant to own redirects).
- **Partial** caught that `verifyToken` doesn't reject `purpose:'swap'` (a swap token could be dropped into the
  session-cookie slot) — an invariant question prompted by the high-level "thin identity-only token" model.
- **Cold** was the most adversarial — it constructed the full account-takeover chain (broad allowlist + unbound
  bearer token + token-in-URL) and tried concrete open-redirect bypasses (all of which the regex correctly denied).

Takeaway: more context → better design-fidelity + contract coverage; less context → better adversarial probing.
The convergence on the core means the security findings are not artifacts of one reviewer's framing.

## Findings (reconciled + my adjudication)

The flow is **structurally sound and faithful** to the design — hub stays the sole issuer, the spoke is
verify-only (only sets the hub-minted cookie), all hub calls go through `@civitai/auth`, top-level nav so the
hub's Lax cookie rides along, cookies httpOnly/Lax, and the open-redirect regex resisted the bypasses thrown at
it. The weak spot is the **threat model of the swap token as a bearer credential in transit**. The three
critical findings compound into one chain.

| # | Finding | Found by | Verdict | Sev |
|---|---------|----------|---------|-----|
| 1 | **Swap token not bound to its callback origin** — `mintSwapToken` encodes only `purpose/sub/jti` (shared `iss`/`aud` with session tokens), so it's a pure bearer credential redeemable by anyone who captures it. Compounded by the **over-broad `SPOKE_ORIGIN` allowlist** (`*.civitai.{com,red,green,blue,work,dev,ai}` — includes speculative/maybe-unowned TLDs). A dangling/compromised family subdomain + a crafted `?callback=` link → the hub redirects the victim's swap token there → account-takeover oracle. | all 3 | **Valid.** The headline. | **HIGH** |
| 2 | **Single-use fails OPEN** — `consumeSwapToken` returns `true` (allow) when sysRedis is unconfigured *and* on any redis error. With the token in a URL (logs/Referer), a token captured during a redis blip is replayable for its full TTL → full session mint. | all 3 | **Valid.** Fail *closed* on error (re-login is recoverable; replay isn't). Keep dev (no-redis) permissive. | **HIGH** |
| 3 | **Swap token rides in the redirect URL** — lands in browser history, the spoke's access logs, and `Referer`. Capture surface for #2. | full, cold | **Valid but partly inherent** (OAuth-code pattern). Mitigate: short TTL + `Referrer-Policy: no-referrer` on the landing + fail-closed #2. | **MED** |
| 4 | **`verifyToken` doesn't reject `purpose:'swap'`** — the only thing stopping a swap token from being accepted in the `civ-token` cookie slot (a short-lived valid-looking session) is that `verifyToken` doesn't check `purpose`. | partial, cold | **Valid.** Add an explicit `purpose==='swap' → reject` guard in `verifyToken`. Cheap. | **MED** |
| 5 | **`isSecureCookie()` fallback fragility** — if a spoke has `NEXT_PUBLIC_BASE_URL` unset it falls back to the hub issuer (https in prod) → sets a `Secure`/`__Secure-` cookie. On an http spoke that's silently dropped (confusing); on a misconfigured prod spoke served over http it's a downgrade. | full, cold | **Valid** (misconfiguration class). Require `NEXT_PUBLIC_BASE_URL` on a spoke in prod (assert loudly). | **MED** |
| 6 | **Swap marker TTL hardcoded `60s`** vs the token TTL `AUTH_SWAP_MAX_AGE ?? 60`. Raising the env above 60s makes the marker expire before the token → replay window. | full | **Valid.** Derive the marker TTL from `AUTH_SWAP_MAX_AGE`. | LOW |
| 7 | **Spoke `SELF_ORIGIN` falls back to `https://${Host header}`** (attacker-controllable). Mitigated by the hub's allowlist, but fragile. | partial, cold | **Valid.** Require `NEXT_PUBLIC_BASE_URL`; drop the Host fallback. | LOW |
| 8 | **No origin/rate-limit on `/api/auth/exchange`** — unauthenticated by design (swap token is the credential), but an attacker can burn a victim's in-flight `jti` before the spoke redeems (a narrow DoS). | full, cold | **Valid, low.** Origin allowlist + rate-limit; jti is a random UUID + 60s. | LOW |
| 9 | **`409 already-used` → `/login?error=sync`** — a benign double-nav (back button) bricks the bootstrap. | full | **Valid UX.** Distinguish used-vs-invalid; continue if already authed. | LOW |

Acknowledged follow-ups already in the cutover doc (not regressions): cross-domain login doesn't link the
spoke's **device set** (server-to-server, no device cookie) → multi-account on `.red` needs that; e2e validation
pending; STEP-H deletion of the dead `account-switch-hub` receiver.

## Recommendations (prioritized)

**P0 — before this path is enabled anywhere:**
1. **Tighten the callback allowlist** to an explicit, env-driven set of known spoke origins (drop the speculative
   TLDs), AND **bind the swap token to its callback** (`aud = callback origin`, verified on exchange) as
   defense-in-depth. *(#1)*
2. **Fail closed** in `consumeSwapToken` on a redis error (keep no-redis/dev permissive). *(#2)*
3. **`verifyToken` rejects `purpose:'swap'`.** *(#4)*

**P1:**
4. Derive the swap marker TTL from `AUTH_SWAP_MAX_AGE`; require `NEXT_PUBLIC_BASE_URL` on spokes (drop the Host
   fallback; assert https in prod); `Referrer-Policy: no-referrer` on the spoke landing. *(#3, #5, #6, #7)*

**P2:** origin allowlist + rate-limit on `/api/auth/exchange`; the `409` UX. *(#8, #9)*

## Resolution (2026-06-16) — P0 + most P1 applied

Verified green (package 87 tests, hub 0/0, main typecheck 0):

- **#1 ✅** The hub callback allowlist is now an **explicit exact-origin set** from `AUTH_SPOKE_ORIGINS` (env,
  comma-separated) — no broad pattern; localhost only in dev. The hub also validates the reflected `returnUrl`
  is root-relative. ⚠️ **New env: `AUTH_SPOKE_ORIGINS` must be set on the hub per environment** (e.g.
  `https://civitai.com,https://civitai.red`) or cross-domain sync denies all callbacks. *(I left explicit
  `aud`-to-callback binding out — without origin-proofed redemption it adds little over the exact allowlist;
  noted as a future enhancement if redemption ever carries a verifiable origin.)*
- **#2 ✅** `consumeSwapToken` now **fails closed** on a redis error (dev/no-redis stays permissive).
- **#4 ✅** `verifyToken` rejects `purpose:'swap'`, so a swap token can't pose as a session cookie (+ test).
- **#6 ✅** the single-use marker TTL derives from `AUTH_SWAP_MAX_AGE` (+buffer), not a hardcoded 60.
- **#7 ✅** the spoke requires `NEXT_PUBLIC_BASE_URL` (no `Host`-header fallback) + sets `Referrer-Policy:
  no-referrer` on the receive.
- **#3** partly addressed (Referrer-Policy + fail-closed single-use); the token-in-URL is inherent to the
  pattern — short TTL + single-use are the mitigations.
- **#5** (isSecureCookie fallback), **#8** (exchange rate-limit), **#9** (409 UX) — left as noted follow-ups.
