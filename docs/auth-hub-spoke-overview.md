# Auth: hub ↔ apps — architecture overview

A standalone description of how authentication is *supposed* to work across the monorepo. This is the spec — use
it to check whether the implementation matches the intent. It does not describe the (in-progress) cutover steps,
only the target architecture.

## 1. Roles

- **Hub** — `apps/auth` (SvelteKit, `auth.civitai.com`). The **sole producer and issuer** of sessions. It runs
  login (OAuth/email), mints session tokens, holds the signing key, and publishes its public key (JWKS).
- **Spokes** — every other app: the main app (`civitai.com`, Next.js), `civitai.red` (same Next codebase, a
  different registrable domain), and the moderator app. Spokes are **consumers**: they verify and read sessions,
  but never mint them.
- **`@civitai/auth` package** — the **only** interface between any app and the hub. All hub interaction goes
  through it (see §6). Apps never hand-roll a request to the hub.

## 2. The session token (`civ-token`)

- A **thin** ES256-signed JWS. Claims are **identity-only**: `sub` (userId), `jti` (session/token id),
  `signedAt`, plus standard `iss`/`iat`/`exp`. It does **not** embed the rich user.
- Stored as an httpOnly cookie on `.civitai.com`: `__Secure-civ-token` in prod (https), `civ-token` in dev
  (http). The cookie name + secure flag are derived in one place in the package (`sessionCookieName()`,
  `isSecureCookie()`) so the hub and every spoke agree.
- The **rich user** is resolved per-request from a **shared Redis cache** (`session:data2:{userId}`) that the hub
  populates. Spokes read the cache; on a miss they fetch the hub's identity endpoint. One producer, many readers.

## 3. Verification (spokes)

- Spokes verify the `civ-token` **locally** with the hub's **public key** (ES256/JWKS) — no per-request hop to
  the hub to validate a token.
- The **private key never leaves the hub**. No shared symmetric secret is needed for verification.
- Resolving the user after a valid token: **shared cache → hub identity endpoint on a miss**.

## 4. Core flows

- **Login** — happens at the hub. A spoke redirects to the hub's `/login` (with a `returnUrl`); the hub
  authenticates, mints a `civ-token`, sets the cookie, and redirects back.
- **Logout** — the spoke clears its cookies and asks the hub to **revoke** the token (best-effort; a hub blip
  must never block logout).
- **Rolling refresh** — the thin token is a fixed window from issue. When it ages past the update age (~24h of
  activity), the spoke asks the hub to **re-mint** the same session (same user, fresh window) and re-sets the
  cookie. Only the hub can mint.

## 5. Multi-account + impersonation

- **Device-level account switching.** The hub keeps a **per-browser device set**: an httpOnly `civ-device`
  cookie maps to a Redis set `device:accounts:{deviceId}` of `userId → lastSwitchedAt`, **30-day rolling**.
  - A switch is authorized by **an active session AND the target being in this device's set and fresh (<30d)**.
    No client-held credential, and no DB-level User↔User link (so no cross-device association).
  - The browser keeps a **durable, credential-free roster** (localStorage: `{id, username, avatar}`) purely so
    the user always sees which accounts they've used here. Switchability is the device set; an account that
    ages out of the 30-day window stays listed but requires a fresh login when clicked.
- **Moderator impersonation.** The **only** authorization is that the requester's own session is a **moderator**
  (no internal token, no extra credential). The hub mints a `civ-token` for the target carrying an
  `impersonatedBy: <moderatorId>` claim; "exit" reads that claim and re-mints the moderator's session.
  Impersonation does **not** touch the device account set. The audit (`ModActivity`) is written by the app.

## 6. The package boundary (critical invariant)

**No app ever hand-rolls a request to the hub.** Every hub interaction goes through `@civitai/auth`:

- **Server → hub** clients: `createSessionClient` (token→user, invalidate/refresh), `createDeviceAccountClient`
  (account-set list/switch/remove), `createSessionTokenClient` (rolling refresh + revoke),
  `createImpersonationClient` (impersonate/exit), `createSessionSigner` (hub-only minting), `createAuthVerifier`.
- **Browser → same-origin proxy** client: `@civitai/auth/client` (`authClient`) — `listAccounts` / `switchAccount`
  / `removeAccount` / `impersonate` / `exitImpersonation`. Browser-safe (no server deps).
- **App API routes** that touch the hub are **thin proxies** over the server clients: they forward the browser's
  cookies and add only framework glue (e.g. setting the response cookie). No hub URLs or request shapes inline.
- **Client components** never `fetch` an auth endpoint directly — they go through the app's account context
  (`AccountProvider`), which calls `authClient`.

Why: a single producer + single contract means a hub route or session-shape change touches one package, not
dozens of call sites.

## 7. Cross-domain (`civitai.red`, and `localhost` against prod)

A different registrable domain can't see the `.civitai.com` cookie. So the hub mints a short-lived **swap token**,
redirects to the spoke with it, and the spoke **exchanges** it at the hub for its own `civ-token` (stored in its
own cookie). `localhost` developing against the prod hub is just another such cross-domain spoke. Cookie
secure-ness must follow the **spoke's own** serving protocol (http localhost ⇒ non-secure cookie), not the
issuer's. *(This exchange is planned; same mechanism for `.red` and localhost.)*

## 8. Security invariants (must always hold)

- The signing **private key lives only on the hub**; spokes are verify-only.
- The `civ-token` is **identity-only** — no authorization/role data is trusted from the token body beyond
  identity; roles come from the resolved user.
- **No client-held long-lived credential** grants account access (the old localStorage AES token is gone);
  switching is gated server-side by the device set, impersonation by moderator status.
- Service-to-service hub calls (cache bust/refresh by userId) use a dedicated `AUTH_INTERNAL_TOKEN`, never a
  user session token.
- Secrets are never committed; `.env` is gitignored.
