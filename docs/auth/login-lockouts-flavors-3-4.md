# OAuth Login Lockouts — Flavors 3 & 4

**Parent task:** [868k9gug8 — OAuth / Google login lockouts](https://app.clickup.com/t/868k9gug8)
**Scope:** deep-dive + recommended fixes for the two hardest flavors — (3) *cannot disconnect Google / no email fallback / CAPTCHA fails* and (4) *assorted full lockouts*. Flavors 1 (multi-account) and 2 (redirect loop) are tracked separately.

## Context: the auth stack moved to a centralized hub

Login is no longer NextAuth in the main app. It's a **SvelteKit hub at `apps/auth` (auth.civitai.com)** plus a `@civitai/auth` package. Every color (civitai.com, civitai.red) redirects to the same hub to log in; the hub owns the login UI, magic-link, CAPTCHA, and OAuth. The main Next app only owns *account management* (connected accounts, change-email). This migration is recent and almost certainly correlates with the lockout reports. `docs/features/account-switching.md` is now stale.

**Already shipped:**

- Server-side last-login-method guard on `account.delete` — `src/server/services/account.service.ts` (flavors 1/2/4)
- Redirect-loop breaker in `src/pages/api/auth/post-login.ts` (catches the "civ-token lands but won't verify" loop that `authorize.ts`'s presence-only probe can't) (flavor 2)
- **#1** — `confirmEmailChange` now sets `emailVerified` (`src/server/services/email-verification.service.ts`) so the verified-email fallback actually satisfies the disconnect guard + hub magic-link login (flavor 3A)
- **Auth-flow instrumentation** — `authorize.ts` / `callback.ts` / `post-login.ts` now emit `logToAxiom({ name: 'auth-flow', step, outcome, host })` to `civitai-prod`. Since these spoke endpoints run in the main app (which *does* ship to Axiom, unlike the hub), the `.red`-vs-`.com` return-leg outcomes become queryable **once this deploys** — see the telemetry note.
- **#3 — interactive-CAPTCHA fallback** (hub, `apps/auth`) — when the invisible Turnstile widget can't issue a token, the client now renders a **managed (interactive) challenge** instead of un-gating a doomed tokenless submit (`+page.svelte`); the server verifies it against `CF_MANAGED_TURNSTILE_SECRET` by `captchaMode` (`captcha.ts` + `+page.server.ts`). Invisible path is untouched, and the whole thing is **gated on `CF_MANAGED_TURNSTILE_SITEKEY`** — unset ⇒ behavior == pre-fallback, so it's a no-op until the managed key is provisioned. Ships with **`CAPTCHA_DEV`** dev wiring (real captcha on localhost via CF test keys) and the **`no_token` split** (`failReason` = widget-error / timeout / fallback-error) to size the recoverable vs fully-blocked populations.
- **#4 — `oauth_state` diagnostic split** (`packages/civitai-auth` first-party-bridge) — `completeFirstPartyCallback` now returns a `detail` sub-reason, logged by `callback.ts` on `exchange-error`, so the `.red` failure is no longer one opaque code. `oauth_state` → `no_code` (hub returned no code/state) / `no_cookie` (bridge cookie didn't survive the cross-site round-trip) / `state_mismatch` (a concurrent/stale login clobbered the single bridge cookie); `oauth_exchange` → `declined` / `network`. The three `oauth_state` sub-causes need DIFFERENT fixes, so this measures which one `.red` actually hits before we build it (the bridge cookie is already `SameSite=Lax; Secure; HttpOnly; Path`-scoped — correct — so a blind `SameSite` flip is the wrong move). **Next:** post-deploy, run the query below; the dominant `.red` detail picks the fix.

  ```kusto
  ['civitai-prod']
  | where _time > ago(7d) and name == 'auth-flow' and outcome == 'exchange-error'
  | summarize count() by tostring(error), tostring(detail), tostring(host)
  ```

  Likely outcomes → fix: `no_cookie` dominant ⇒ cross-site delivery (Safari ITP / privacy modes — hard; consider a non-cookie state carry); `state_mismatch` dominant ⇒ make the bridge cookie **concurrency-tolerant** (ring of recent PKCE/state entries instead of one fixed-name cookie); `no_code` dominant ⇒ hub-side redirect/`redirect_uri` issue.

---

## Flavor 3 — cannot disconnect Google / no email fallback / CAPTCHA fails

**There is no password login anywhere in the codebase** (verified: zero `bcrypt` / `credentials` / `setPassword` hits). "Set a password to use email login" is impossible by design. The only non-OAuth login method is the **email magic-link**. So every flavor-3 lockout reduces to: *the magic-link path is unavailable to this user.* Three independent causes:

### A. The `emailVerified` trap (highest leverage)

Two guards gate on `emailVerified`, NOT `email`:
- the new server guard on `account.delete` (`src/server/services/account.service.ts`)
- the client `canRemoveAccounts` check — `src/components/Account/AccountsCard.tsx:61`

But the **only** self-service way to set `emailVerified` is completing a hub magic-link login (`apps/auth/src/lib/server/auth/users.ts:206-212`). The main-app **"Change Email"** flow (`src/components/Account/ProfileCard.tsx` → `requestEmailChange` / `confirmEmailChange`) sends a verification link and, on click, updates `email` but **leaves `emailVerified` null** — `src/server/services/email-verification.service.ts:121-124`:

```ts
await dbWrite.user.update({
  where: { id: userId },
  data: { email: newEmail },   // ← emailVerified is NOT set, even though the token round-trip proved ownership
});
```

**Net effect:** a user can prove they own an inbox (they clicked the emailed token link) and *still* be unable to disconnect Google or use email login, because `emailVerified` stays null.

**Fix (one line):** have `confirmEmailChange` also set `emailVerified: new Date()`. The verification-token round-trip already proves ownership. This turns change-email into a genuine unlock and makes the disconnect guard escapable through the UI.

### B. CAPTCHA fails for a subset of users, with no fallback

> **@dev:** confirmed — hub `ORIGIN` and the Turnstile key pair are set correctly. If they weren't, Turnstile would be failing for *simple* (all) email login.
> **@ai:** Agreed, and that confirmation is diagnostic: a global `ORIGIN`/hostname-pin misconfig would break email login for *everyone*, which isn't what's happening. So the "CAPTCHA fails repeatedly" cluster is **per-user**, not a server config problem. Rewriting this section accordingly — the config-check hypothesis is ruled out.

Invisible Cloudflare Turnstile, **fail-closed** when enabled — `apps/auth/src/lib/server/auth/captcha.ts:55-120`. Server config (`ORIGIN`, `CF_INVISIBLE_TURNSTILE_SITEKEY`/`SECRET`, hostname allow-list) is **confirmed correct**, so the hostname-pin path is *not* the cause. The real mechanism is client-side and per-user:

1. The **invisible** widget runs a background check and issues a token via `onAuthCaptcha`. For a subset of users it never issues one — Turnstile bot-scoring, a VPN/Tor exit, privacy tooling (Brave shields, uBlock), or an ISP/region that blocks `challenges.cloudflare.com` / the `api.js` script (`+page.svelte:103-105`).
2. When that happens, `onAuthCaptchaError` **or** the 8s timeout sets `captchaUnavailable = true` (`+page.svelte:83-92`), which flips `captchaPending` to false and **enables** the submit button — but there is still **no token**.
3. The user clicks "Email me a login link"; the form POSTs an **empty** `cf-turnstile-response`; the server hits `no_token` and fail-closes (`captcha.ts:58-61`) → `fail(400, { captcha: true })` → "Captcha verification failed. Please try again." (`+page.svelte:211`).
4. They retry; the same browser/network condition reproduces the empty token → **guaranteed-fail loop**. Because the widget is *invisible*, there is no interactive challenge to solve and **no alternate email-login path** — the user is stuck.

The "safety valve" (soft-release on error/timeout) is actually **counterproductive** here: it converts a disabled button into an enabled button that always 400s. It prevents a *permanently-disabled* button but not a *permanently-failing submit*.

**Fix:** give the failing subset a real path instead of a doomed tokenless POST. When `onAuthCaptchaError`/timeout fires, render an **interactive (managed) Turnstile widget as a fallback** (or execute Turnstile in interactive mode) so those users can actually solve a challenge and obtain a token — keeping the invisible fast-path for the ~99%. (Note: the hub *moved off* the managed widget as the *primary* because it only ~50% solved; using it only as a **fallback** for the invisible-fail subset avoids that regression while unblocking the stuck users.) Needs product/security sign-off. Confirm the failure signature first via the `captchaVerificationsTotal` metric — a spike in `no_token` (vs `hostname_mismatch`/`siteverify_failed`) proves this diagnosis.

### Does CAPTCHA need separate sitekey/secret for civitai.com and civitai.red?

**No.** The login page and its Turnstile widget are served exclusively by the hub at `auth.civitai.com`, for *both* colors — civitai.com and civitai.red each redirect/bridge to the same hub to log in. The token is therefore always solved on `auth.civitai.com`, and the hostname-pin (`captcha.ts:99-103`) checks it against the hub's own `ORIGIN` host. **One invisible key pair covers both colors.**

Requirements for it to work:
1. The Turnstile widget in the Cloudflare dashboard must list **`auth.civitai.com`** as an allowed hostname.
2. Hub **`ORIGIN=https://auth.civitai.com`** so the hostname-pin matches the solved token.

Separate per-color keys would only be needed if login were served from each color's *own* domain — it isn't. The one cross-property nuance: because the same invisible key is shared with the main civitai.com app's own captcha flows, the hub deliberately pins to its own hostname to reject tokens solved elsewhere. (If the main app renders this key on civitai.red for its *own* non-login forms, that hostname must be in the CF widget's allow-list — but that's unrelated to login.)

### C. `email` doesn't match / is null

Magic-link matches purely on `User.email` (`findOrCreateUserByEmail`, `users.ts:189-213`). If the account has `email = null` (see Flavor 4) or a different address, the link either fails or **creates a brand-new account** instead of recovering the old one.

---

## Flavor 4 — full lockouts

### How an account exists with NO email AND NO usable social

User creation makes `email` fully optional — `apps/auth/src/lib/server/auth/users.ts:120-140` (`email: profile.email ?? null`, `emailVerified: … ? new Date() : null`). **Reddit** requests only `identity` scope and returns no email at all (`apps/auth/src/lib/server/auth/providers.ts:112-129`), so **every Reddit signup is email-less**, its sole login method the one `Account` row. (Discord could also return no email if the token response omits it; GitHub private-email recovery is best-effort.)

Historically that sole `Account` row could be deleted (the client guard was the only check) → permanent lockout. The new server guard stops *new* occurrences but **does not heal existing victims**.

### Recovery tooling is thin

The only admin re-link is Retool **`updateIdentity`** → `forceUpdateUserIdentity` (`src/pages/api/mod/retool/user.ts:73-100`, `src/server/services/user.service.ts:492-542`). It can set/correct an `email` (bypassing the normal "don't overwrite" guard) but:
- **cannot re-attach or reset an OAuth provider** (`providerAccountId`)
- does **not** set `emailVerified`

Recovery chain today: mod sets email via Retool → user requests magic link → link-click sets `emailVerified` and recovers the *existing* account. This only works if the mod sets the email **first** (otherwise magic-link spawns a new account). There is no self-service recovery, and no tool to unlink a compromised provider row.

### civitai.red-specific login failure — trust-registry ruled out; it's the cross-domain cookie return

> **@dev:** confirmed — `TrustedSpokeDomain` has an enabled `civitai.red` row.
> **@ai:** Acknowledged. That rules out the `400 invalid_client` gate below — the hub *does* authorize .red. So the .red-specific failure is downstream of authorization, on the **return** leg.

civitai.red can't read the hub's `.civitai.com` cookie, so it runs the first-party OAuth bridge. The hub authorizes the spoke against the **`TrustedSpokeDomain` table** (`apps/auth/src/routes/api/auth/oauth/authorize/+server.ts:69-70`, `apps/auth/src/lib/server/oauth/first-party.ts:69-105`) — and that row is **confirmed present + enabled**, so authorization is *not* the cause. (The static `CIVITAI_OWNED_DOMAINS` list only governs the post-login redirect backstop; it was never the gate.)

With authorization ruled out, the remaining .red-specific failure is the **return leg**: after the hub login, the spoke bridge (`/api/auth/authorize` → `/api/auth/callback`) must mint and **land civitai.red's own civ-token cookie** (`callback.ts:65`, Domain derived as `civitai.red` via `cookieDomainForHost`). If that cookie doesn't land or doesn't verify on return, **both** email *and* Google login fail on .red (both route through the same hub) — matching ticket 67153. This is the **flavor-2 cross-domain cookie mechanism**; the loop breaker now *surfaces* it as the terminal "couldn't sign you in" page instead of an infinite loop, but does **not fix the underlying cookie landing**.

→ **Action:** since the two static hypotheses (trust row, owned-domains) are both eliminated, pin the actual failure from logs — pull the `.red` `/api/auth/callback` + `/api/auth/authorize` outcomes from Axiom (look for the `POST_LOGIN_MARKER`-present-but-no-session retry path and any `invalid_client`/exchange errors) rather than guessing. See "Recommended fixes" #4 (revised).

### Compromised-provider = account takeover, no second factor

Login resolves solely on `(provider, providerAccountId)` (`users.ts:78-89`) — no password, no 2FA/TOTP, no email-confirmation step. Whoever controls the upstream Google/Discord identity is straight into the Civitai account. Victims with a verified email can self-recover via magic link; **email-less victims cannot recover at all** without mod intervention, and even then the attacker's provider link survives (no unlink tool).

---

## Recommended fixes

| # | Fix | Type | Effort | Notes |
|---|-----|------|--------|-------|
| 1 | `confirmEmailChange` sets `emailVerified: new Date()` | code (1 line) | trivial | Unblocks the disconnect guard + enables email-login self-service. Highest leverage. |
| 2 | Wire the orphaned `resendEmailVerificationSchema` to a "verify current email" endpoint + UI | code | small | Currently defined (`src/server/schema/user.schema.ts:420-423`) but unused — no way to verify an *existing* email, only change to a new one. |
| 3 | **Interactive-Turnstile fallback** for email login: when the invisible widget errors/times out, render a managed challenge instead of enabling a tokenless submit | code | medium | ~~Verify hub `ORIGIN`/key pair~~ **config confirmed correct (@dev)** → ruled out. Real cause is per-user invisible-token failure with no fallback (Flavor 3B). Confirm via a `no_token` spike in `captchaVerificationsTotal`. |
| 4 | **Diagnose the .red cookie-return** from Axiom (callback/authorize outcomes), then fix cookie landing/verification on the spoke return leg | ops→code | small→medium | ~~Confirm `TrustedSpokeDomain` row~~ **confirmed present + enabled (@dev)** → ruled out. Remaining cause is the flavor-2 cross-domain civ-token not landing/verifying on .red (Flavor 4, .red section). |
| 5 | Add a mod tool to **unlink** a compromised OAuth provider row (+ optionally re-link) | code | medium | No current path to detach a stolen Google/Discord identity. |
| 6 | Optional 2FA / email-confirm challenge for provider-delegated login | design | large | Provider takeover currently = full account takeover. |

### Suggested triage order

1. **#1 first** — restores a working self-service email fallback for the largest group (locked-out-but-has-an-email users). One line, no dependencies.
2. **Confirm the two now-open diagnoses with data** (both prior config hypotheses were ruled out by @dev) — see the telemetry note below for *where* the data actually lives.
3. **#3 + #4** — the actual CAPTCHA and .red fixes, once the data confirms them.
4. **#5** — needed to resolve the compromised-account tickets that mods currently can't fully fix.
5. **#2, #6** — follow-ups.

### CONFIRMED from telemetry (post-deploy, first ~90min of prod data, 2026-07-08)

The `auth-flow` + `captcha-reject` instrumentation is live in `civitai-prod`. First read (`name in ('auth-flow','captcha-reject')`):

- **Flavor 3B (CAPTCHA) — CONFIRMED.** Of 16 `captcha-reject` events, **15 = `no_token`, 1 = `siteverify-failed`, 0 = `hostname_mismatch`**. This is exactly the diagnosis: captcha fails because the client submits with **no token** (the invisible widget didn't produce one for that user) — NOT the `ORIGIN`/hostname config we ruled out. Low absolute volume (matches "a handful of tickets"), but each is a hard lockout with no fallback → the **interactive-Turnstile fallback (#3)** is the right fix.
- **Flavor 4 (.red) — concrete lead found.** `.red` `callback:exchange-error` is dominated by **`oauth_state` (25 on `.red` vs 6 on `.com`)** + `oauth_exchange` (4 on `.red`). `oauth_state` = the callback's `state` failed to validate against the **OAuth bridge cookie** (`OAUTH_BRIDGE_COOKIE`, PKCE verifier + state, set by `authorize.ts` and read by `callback.ts`). So the `.red` failure is the **bridge cookie not round-tripping** on the cross-registrable-domain hop through the hub (~4× the `.com` rate) — the *outbound* leg, distinct from the civ-token session cookie. **Next step: audit the bridge cookie's SameSite/Domain on `.red`.**
- **Flavor 2 (redirect loop) — essentially absent.** 0 `authorize:loop-terminal`, 0 `post-login:no-session-terminal`, 1 `post-login:no-session-retry` (self-healed). The infinite-loop/ERR_TOO_MANY_REDIRECTS class is rare or already handled by the breakers.
- **Open (not yet a conclusion):** the `callback:success → post-login:success` gap is larger on `.red` (2330→1690, ~27%) than `.com` (999→930, ~7%), but with ~0 no-session events it's likely non-post-login returnUrls (connect/add-account) or abandonment, **not** cookie-verify failure. Needs a returnUrl breakdown before drawing a conclusion.

Query used:

```kusto
['civitai-prod'] | where _time > ago(7d) and name == 'auth-flow'
| summarize count() by step, outcome, tostring(host)
['civitai-prod'] | where _time > ago(7d) and name == 'captcha-reject' | summarize count() by reason
['civitai-prod'] | where _time > ago(7d) and name == 'auth-flow' and outcome == 'exchange-error'
| summarize count() by tostring(error), tostring(host)
```

### Telemetry: where to pull the confirming data (checked 2026-07-08, pre-instrumentation)

**At the time of this investigation the auth hub (apps/auth) did NOT ship logs or metrics to Axiom** (the `feat(auth-hub): log captcha rejections to Axiom` commit fixed captcha specifically). Confirmed by probing `civitai-prod` and `civitai-next` over 14–30d: zero hits for every hub marker (`captcha verify rejected`, `hostname-mismatch`, `no_token`, `siteverify-failed`, `invalid_client`, `post-login`), and no `/api/auth/*` request logs.

**→ Fixed for the endpoints we control:** the `auth-flow` instrumentation (shipped, see above) makes the `.red`/`.com` return-leg queryable in Axiom **once deployed**. After the deploy, run:

```kusto
['civitai-prod']
| where _time > ago(7d) and name == 'auth-flow'
| summarize count() by step, outcome, tostring(host)
| order by count_ desc
```

Expect flavor-4/.red to show up as `callback:exchange-error` (concentrated on `civitai.red`) and/or a `callback:success` count with far fewer matching `post-login:success` (the cookie-didn't-land gap), plus `authorize:loop-terminal` / `post-login:no-session-terminal` for the loop cases. **This does not cover flavor-3 CAPTCHA** (that verify runs on the hub, which still doesn't ship to Axiom) — for that, still:

- **#3 CAPTCHA** — `captchaVerificationsTotal{result=…}` is a **Prometheus** counter (`apps/auth/.../metrics`), so query **Grafana/Prometheus**, not Axiom. Expect the `no_token` label to dominate rejections if 3B is right (client submits with no token) vs `hostname_mismatch`/`siteverify_failed`. **Cloudflare Turnstile analytics** (CF dashboard, via the `cloudflare` skill) also hold solve/challenge rates for the invisible sitekey.
- **#4 .red return leg** — the hub stdout + the main-app `/api/auth/{authorize,callback}` logs live in the **cluster** (kubectl/Loki), and the edge status codes (400s / redirect-loop terminals on `civitai.red`) are in **Cloudflare HTTP analytics** (`cloudflare` skill) — filter host `civitai.red`, path `/api/auth/callback` + `/api/auth/authorize`.

> **Tooling status (2026-07-08) — none of the prod-telemetry sources are reachable from the repo/session; run these where you have access:**
>
> - **Axiom** — dead end (hub doesn't ship here; confirmed).
> - **`cloudflare` skill** — not credentialed (no `.env`; needs `CF_API_TOKEN` w/ Zone Analytics:Read + the **civitai.red** `CF_ZONE_ID`). Once set: `node .claude/skills/cloudflare/query.mjs top-paths --path '/api/auth/%' --start -7d` and per-path `ip`/status drill-down for host civitai.red. HTTP analytics does **not** include Turnstile solve rates.
> - **Turnstile solve/challenge rate** — Cloudflare **Turnstile dashboard** for the invisible sitekey (separate CF product; no skill).
> - **`captchaVerificationsTotal{result}`** — **Grafana/Prometheus** (expect `no_token` to dominate if 3B holds).
> - **kubectl** — present but **no cluster context configured** here. With a kubeconfig, the single most direct source for *both* #3 and #4 is the auth-hub pod logs: `kubectl logs -l app=auth -n <ns> --since=168h | grep -E 'captcha verify rejected|invalid_client|POST_LOGIN'` — the hub prints `captcha verify rejected` + `reason`/`hostname` and the `.red` callback/authorize outcomes there.

**Only proxy signal Axiom does hold:** the *main app* uses the **same invisible Turnstile key**, and its `recaptcha/client.ts` logged **887 × "Unable to verify captcha token" + 11 × "No response from captcha service" in 30d** (`civitai-prod`) — i.e. the invisible key fails to verify on the order of ~30×/day in the main app alone. That corroborates that invisible-token failures are real and ongoing (Flavor 3B), though it's not the email-login flow and carries no per-user/per-reason breakdown (userId is null on these events).
