# Auth Hub — Launch Checklist

Tracking the outstanding work before `auth.civitai.com` (the SvelteKit login hub) ships to
production. Grouped by severity. Items are checked off as they land. Infra/config (devops-owned)
is at the end.

Context: the hub is the sole session-token **issuer** (RS256 JWS); every other app is a **spoke**
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

- [ ] **3. GitHub private-email users.** `providers.ts` `mapProfile` can return `email: undefined`
      (GitHub hides it by default). Add the `/user/emails` follow-up call so those users get a
      verified primary email (else they create account rows with no email and can't be matched).
- [ ] **4. Account-linking parity.** The hub only links by *verified* email; otherwise it creates a
      new user. The main app uses `allowDangerousEmailAccountLinking` for Google/GitHub. Decide
      whether to match that, or accept duplicate accounts for the same human across providers.
- [ ] **5. Verify own cookie with the local public key.** The hub currently HTTP-fetches its own
      `/api/auth/jwks` to verify session cookies (`lib/server/auth/verifier.ts`). It already holds
      `AUTH_JWT_PUBLIC_KEY` — verifying locally removes a fragile self-dependency (a bad `ORIGIN`
      silently stops `locals.user` from populating, which breaks logout invalidation).
- [ ] **6. Health/readiness route.** Add `/healthz` (or `/api/health`) returning 200 for the k8s
      probes.

## 🟢 Deferred / by-design (note, not blockers)

- [ ] **7. Full `createUser` side-effects on hub signup.** Username provisioning is done; signup
      rewards, default cosmetics, and referral handling still don't run on a hub-originated signup.
      Product decision: replicate in the hub, or have the hub call a shared main-app endpoint.
- [ ] **8. `TOKEN_STATE='refresh'` handling in the hub.** The hub treats only `'invalid'` as
      revoked; it doesn't re-mint on `'refresh'`. Stale claims persist until token expiry for
      hub-read sessions. (Main-app spokes still re-mint via `refreshToken`.)
- [ ] **9. Cross-root `.red` SSO.** Keep the session cookie `SameSite=Lax` (correct/secure for
      `*.civitai.com`). When `.red` is needed, do the swap via a top-level navigation redirect
      (lax cookies ride top-level GETs) rather than a credentialed background fetch — no need to
      weaken to `SameSite=None`.

## 🧪 Testing

- [ ] **10. Expand auth test coverage.** Brainstorm + build out the auth test suite. Candidate
      areas (flesh out and prioritize):
  - **Unit (`@civitai/auth`, vitest — runnable today):** verify edge cases (expired RS256, wrong
    issuer, corrupt legacy JWE → null, revocation injection, swap-token purpose), sign claim shapes
    (`mintIdToken` nonce/`auth_time`/`aud`, `mintSwapToken` purpose), registry invalidate/track/
    isRevoked transitions, redirect `buildPostLoginRedirect` sync/origin matrix. *(In progress —
    initial batch added; see `src/__tests__/`.)*
  - **Hub app (apps/auth):** needs a vitest + `@sveltejs/kit/vite` test setup. Pure-ish units worth
    covering once wired: username candidate generation, rate-limit window math, captcha
    enable/bypass logic, blocklist redis→DB fallback, the redirect wrapper's civitai-origin policy.
  - **Integration / E2E (manual or Playwright):** hub login (each provider + email) sets the
    shared cookie; main app recognizes a hub-issued RS256 cookie; logout at hub → main app rejects
    on next request (revocation E2E); ban → all sessions invalidated cross-app; legacy JWE cookie
    still recognized during migration; redirect-loop guards (`/login` ↔ `/`); blocked-domain +
    captcha rejection paths; rate-limit 429s.
  - **Security:** logout is POST-only (CSRF), RS256 claims contain no secret/billing fields,
    swap token is single-use + short-lived.

---

## ⚙️ Infra / config — devops (not code)

These are environment/deployment concerns, owned by the devops/deploy process — not code changes.

- [ ] **adapter-node `ORIGIN=https://auth.civitai.com`** — *critical*. Without it, `url.origin` is
      wrong behind the proxy, so OAuth `redirect_uri`s and email links break.
- [ ] **RSA keypair → secret manager:** `AUTH_JWT_PRIVATE_KEY` (PKCS8), `AUTH_JWT_PUBLIC_KEY`
      (SPKI), `AUTH_JWT_KID`. Generate with
      `openssl genpkey -algorithm RSA -out priv.pem -pkeyopt rsa_keygen_bits:2048` then
      `openssl pkey -in priv.pem -pubout -out pub.pem`. Private key stays **only** on the hub.
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
