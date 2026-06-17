# Auth Hub — Launch Checklist

Tracking the outstanding work before `auth.civitai.com` (the SvelteKit login hub) ships to
production. Grouped by severity. Items are checked off as they land. Infra/config (devops-owned)
is at the end.

Context: the hub is the sole session-token **issuer** (ES256 JWS); every other app is a **spoke**
that verifies locally via JWKS. See [centralized-auth-app.md](centralized-auth-app.md) and
[auth-verification-strategy.md](auth-verification-strategy.md).

---

## 🔴 Should fix before prod — code

- [x] **1. Protect the email magic-link endpoint.** Port the main app's `isAllowedToSignIn`
      (`getBlockedEmailDomains` + Cloudflare Turnstile) into the hub's email action. As shipped it
      was a public, unauthenticated "send email to arbitrary address" action.
      → `lib/server/auth/blocklist.ts`, `lib/server/auth/captcha.ts`, wired into
      `login/+page.server.ts` + the Turnstile widget in `login/+page.svelte`.
- [x] **2. Rate limiting on the hub.** Add a redis sliding-window limiter (mirrors
      `server/oauth/rate-limit.ts`) on the email action and the OAuth login start.
      → `lib/server/auth/rate-limit.ts`.

## 🟡 Should fix before merge — code

- [x] **3. GitHub private-email users.** `fetchProfile` now does the `/user/emails` follow-up
      (`emailsUrl` on the GitHub provider) and picks the verified primary email, so a private-email
      GitHub user gets a verified email for linking. → `lib/server/auth/providers.ts`.
- [x] **4. Account-linking parity.** Decided: keep **verified-email-only** linking — the safe
      analogue of `allowDangerousEmailAccountLinking` (Google/GitHub verify emails, so same-person
      logins link with no duplicate; we deliberately do NOT link on an *unverified* email, which is
      an account-takeover vector). With #3, GitHub now provides a verified email, so the duplicate
      concern is resolved. Documented in `lib/server/auth/users.ts`.
- [x] **5. Verify own cookie with the local public key.** `createAuthVerifier` now defaults
      `publicKeyPem` from `AUTH_JWT_PUBLIC_KEY` and verifies ES256 **locally** when present (no
      self-HTTP-fetch); spokes without the key still use JWKS. → `@civitai/auth/verify.ts`,
      `lib/server/auth/verifier.ts`.
- [x] **6. Health route.** `GET /api/health` → 200 `{status:'ok'}` (no DB/redis work, so it won't
      flap). → `routes/api/health/+server.ts`.

## 🟢 Deferred / by-design (note, not blockers)

- [ ] **7. Full `createUser` side-effects on hub signup.** Username provisioning is done; signup
      rewards, default cosmetics, and referral handling still don't run on a hub-originated signup.
      Product decision: replicate in the hub, or have the hub call a shared main-app endpoint.
- [~] **8. `TOKEN_STATE='refresh'` handling — SUPERSEDED by the thin-token design.** The fat-token
      refresh machinery (`checkSession`-on-`'refresh'`, `getState`, `createSpokeSessionChecker`,
      `/userinfo`-on-refresh) was built and validated but **not committed**, then superseded: thin
      cookies have no snapshot to refresh. See **[thin-session-token-design.md](./thin-session-token-design.md)**
      (replaces #8 and #11). Keep from that work: the verifier, signer, per-token track/invalidate,
      and `/api/auth/userinfo` (repurposed as the shared resolve source).
- [ ] **9. Cross-root `.red` SSO.** Keep the session cookie `SameSite=Lax` (correct/secure for
      `*.civitai.com`). When `.red` is needed, do the swap via a top-level navigation redirect
      (lax cookies ride top-level GETs) rather than a credentialed background fetch — no need to
      weaken to `SameSite=None`.
- [ ] **11. THIN session token — DECIDED.** Full design (cookie = identity only; resolve the user from
      a shared source per request; `@civitai/auth` auto-wires redis+db and owns `getSessionUser`;
      `verifyToken` vs `getSessionUser` split; revocation without `SESSION.ALL`; per-app implementation
      for the hub + main app): **[thin-session-token-design.md](./thin-session-token-design.md)**.
      Clincher = cross-root consistency (`.com`/`.red` separate cookies can't be kept coherent as fat
      snapshots). First gating step: the **field audit** in that doc.
- [ ] **12. Main app onto `@civitai/auth` — folded into the thin-token design.** The main app's own
      marker logic (`refreshToken`/`token-tracking`/`session-invalidation`) is reworked as part of the
      thin migration (always-resolve `session.user`, drop the refresh/re-mint path, `SESSION.ALL`, and
      `needsCookieRefresh`; keep single-session invalidate). Per-app steps + the keep/drop list are in
      **[thin-session-token-design.md](./thin-session-token-design.md)** ("Implementation — main civitai
      app"). The earlier fat-token mapping in [auth-hub-main-app-changes.md](./auth-hub-main-app-changes.md)
      is partly superseded — the de-dup goal stands, the `createSessionChecker` mechanism does not.
      **Timing:** the hot `session()`/`refreshToken` path still lands AFTER the dry-run.

## 🧪 Testing

- [ ] **10. Expand auth test coverage.** Brainstorm + build out the auth test suite. Candidate
      areas (flesh out and prioritize):
  - **Unit (`@civitai/auth`, vitest — runnable today):** verify edge cases (expired ES256, wrong
    issuer, corrupt legacy JWE → null, revocation injection, swap-token purpose), sign claim shapes
    (`mintIdToken` nonce/`auth_time`/`aud`, `mintSwapToken` purpose), registry invalidate/track/
    isRevoked transitions, redirect `buildPostLoginRedirect` sync/origin matrix. *(In progress —
    initial batch added; see `src/__tests__/`.)*
  - **Hub app (apps/auth):** needs a vitest + `@sveltejs/kit/vite` test setup. Pure-ish units worth
    covering once wired: username candidate generation, rate-limit window math, captcha
    enable/bypass logic, blocklist redis→DB fallback, the redirect wrapper's civitai-origin policy.
  - **Integration / E2E (manual or Playwright):** hub login (each provider + email) sets the
    shared cookie; main app recognizes a hub-issued ES256 cookie; logout at hub → main app rejects
    on next request (revocation E2E); ban → all sessions invalidated cross-app; legacy JWE cookie
    still recognized during migration; redirect-loop guards (`/login` ↔ `/`); blocked-domain +
    captcha rejection paths; rate-limit 429s.
  - **Security:** logout is POST-only (CSRF), ES256 claims contain no secret/billing fields,
    swap token is single-use + short-lived.

---

## ⚙️ Infra / config — devops (not code)

These are environment/deployment concerns, owned by the devops/deploy process — not code changes.

- [ ] **adapter-node runtime vars** — *critical* behind the ingress:
      - `ORIGIN=https://auth.civitai.com` — without it `url.origin` is wrong, breaking OAuth
        `redirect_uri`s, email links, and the CSRF origin check on login/logout POSTs.
      - `ADDRESS_HEADER=x-forwarded-for` + `XFF_DEPTH=<proxy depth>` — so `getClientAddress()`
        returns the real client IP; the email/login **rate limiter** and Turnstile `remoteip` depend
        on it, else every request looks like the ingress IP and the limits become global.
- [ ] **EC P-256 keypair → secret manager:** `AUTH_JWT_PRIVATE_KEY` (PKCS8), `AUTH_JWT_PUBLIC_KEY`
      (SPKI), `AUTH_JWT_KID`. The signer hardcodes **ES256**, so this MUST be an EC P-256
      (prime256v1) keypair — an RSA key throws at import. Generate with
      `openssl ecparam -genkey -name prime256v1 -noout -out priv.pem` then
      `openssl ec -in priv.pem -pubout -out pub.pem`. Private key stays **only** on the hub.
- [ ] **Session/issuer env:** `AUTH_COOKIE_DOMAIN=.civitai.com`,
      `AUTH_JWT_ISSUER=https://auth.civitai.com`,
      `AUTH_JWKS_URI=https://auth.civitai.com/api/auth/jwks`.
- [ ] **Shared backends (same as main app):** `DATABASE_URL`, `REDIS_URL`, `REDIS_SYS_URL`,
      `NEXTAUTH_SECRET` (email-token hashing + legacy-cookie decode during migration).
- [ ] **Captcha (Turnstile, managed widget):** set both halves on the **hub's** deployment — env is
      per-deployment, so the hub needs its own copy even though the main app already has the managed
      widget configured: `CF_MANAGED_TURNSTILE_SECRET` + `CF_MANAGED_TURNSTILE_SITEKEY` (the hub's
      sitekey value is the main app's `NEXT_PUBLIC_CF_MANAGED_TURNSTILE_SITEKEY`, stored without the
      prefix). If the secret is unset, the email login runs with **no** captcha (silently disabled).
- [ ] **OAuth provider creds + redirect URIs:** set `*_CLIENT_ID`/`*_CLIENT_SECRET`, and register
      `https://auth.civitai.com/login/<provider>/callback` in each provider console.
- [ ] **Email (SMTP):** `EMAIL_HOST`/`PORT`/`USER`/`PASS`/`FROM`.
- [ ] **Deploy plumbing:** Dockerfile → CI/registry/k8s Deployment + Service + Ingress, DNS for
      `auth.civitai.com`, TLS cert.
