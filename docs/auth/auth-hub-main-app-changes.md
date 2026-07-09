# Main App — Auth Hub Support & `@civitai/auth` Consolidation

> **SUPERSEDED (2026-06-17):** this doc describes the abandoned **fat RS256** token model. The shipped design is a **thin ES256** token (identity-only: `sub`/`jti`/`signedAt`, no embedded user) — see [thin-session-token-design.md](./thin-session-token-design.md). The 'fat RS256' framing below is historical.

What the **main civitai app** needs for the auth-hub launch, split into (A) what's required to *support*
the hub (done) and (B) consolidating the main app onto the `@civitai/auth` package so the session-marker
protocol lives in one place (checklist item #12). See [auth-hub-launch-checklist.md](./auth-hub-launch-checklist.md).

Decision context (so we don't relitigate it):
- **Keep the FAT token** — the hub encodes the full session user in the (base64-readable) RS256 JWT, so
  consumers — incl. cache-less/external/edge apps — read the session **self-contained**, no backend call.
  Thin-token (resolve-from-cache) was considered and rejected for now: it would force those cache-less
  consumers into a per-request hub round-trip. (Revisit only as a *split* if token size becomes a real
  concern — see checklist #11.)
- The legacy **NextAuth JWE read is permanent**, not migration scaffolding (some issuers/apps keep using
  NextAuth), so the dual-format verify + `NEXTAUTH_SECRET` stay indefinitely.

---

## A. Support the hub (fat token) — DONE

The main app is already launch-ready as a verify-only spoke; **no new code** required, only config.

- **Reads RS256 + legacy JWE** — the verify-only decode in `src/server/auth/next-auth-options.ts`
  (`createAuthVerifier().verifyToken`) handles both formats. Revocation/refresh is still done by the
  existing `refreshToken` in the `session()` callback (works on either format).
- **Login redirect to the hub** — `src/pages/login/index.tsx` (redirects when `AUTH_JWT_ISSUER` is set).
- **Config only:**
  - Set `AUTH_JWKS_URI` + `AUTH_JWT_ISSUER`, keep `NEXTAUTH_SECRET`.
  - **Do NOT** set `AUTH_JWT_PRIVATE_KEY` / `AUTH_JWT_PUBLIC_KEY` on the main app — that keeps it
    verify-only **via JWKS** (key rotation handled by the hub), with the private key living only on the hub.

> Launch interop is already correct **without** the Part-B consolidation: the main app's existing
> marker logic uses the **same** redis keys + `'invalid'`/`'refresh'` semantics as the hub's
> `createSessionRegistry`, so they interoperate today. Part B is a maintainability/drift win, not a
> correctness fix, and is **not a launch blocker**.

---

## B. Consolidate onto `@civitai/auth` (#12)

The main app currently has its **own copy** of the session-marker protocol across three files
(`token-tracking.ts`, `session-invalidation.ts`, `token-refresh.ts`) — a parallel implementation of what
`createSessionRegistry` now owns, which can drift. Collapse it onto one `sessionRegistry` instance:

```ts
// src/server/auth/session-registry.ts (new)
export const sessionRegistry = createSessionRegistry({
  redis: sysRedis,
  keys: {
    tokenState: REDIS_SYS_KEYS.SESSION.TOKEN_STATE,
    all:        REDIS_SYS_KEYS.SESSION.ALL,
    userTokens: REDIS_KEYS.SESSION.USER_TOKENS,
  },
  onInvalidate: (info) => { /* app side-effects: clearSessionCache / signal / cache pattern clear */ },
});
```

### Mapping

| Main-app function | → Package |
|---|---|
| `token-tracking.trackToken` | `registry.trackToken` |
| `token-tracking.invalidateToken` | `registry.invalidateToken` (+ `onInvalidate` → `clearSessionCache`) |
| `session-invalidation.invalidateSession` | `registry.invalidateUserSessions` (+ `onInvalidate` → signal) |
| `session-invalidation.invalidateAllSessions` | `registry.invalidateAll` (+ `onInvalidate` → cache-pattern clear) |
| `session-invalidation.refreshSession` | **new** `registry.refreshUserSessions` |
| `token-refresh.refreshToken` (marker read) | `registry.getState` |
| `token-refresh.clearTokenRefreshMarker` | **new** `registry.clearMarker` |

### Package additions needed (small, in `@civitai/auth` `session-registry.ts`)
- `refreshUserSessions(userId)` — mark all a user's tracked tokens `'refresh'` (symmetric to
  `invalidateUserSessions`; reads `USER_TOKENS`, `hSet` each → `'refresh'`).
- `clearMarker(tokenId)` — `hDel TOKEN_STATE[tokenId]` (for `clearTokenRefreshMarker`).

### App glue that STAYS (NextAuth/app-specific — injected via `onInvalidate` or kept in the wrapper)
- `getSessionUser` re-resolve + `setToken` + `signedAt` (the fat-token refresh itself).
- `needsCookieRefresh` signaling + the realtime `signalClient` send.
- The **untracked-token self-heal** (`hExists(USER_TOKENS)` branch in `refreshToken`) — `getState`
  doesn't cover this; keep it in the app glue.
- The **throw-vs-fail-open** distinction: `invalidateSession` *throws* on sysRedis failure (a security
  property); `trackToken` swallows. Keep that in the wrappers (registry methods await redis directly, so
  the wrapper chooses `.catch()` or let-it-throw).
- Delete the now-redundant **dead** `src/server/auth/session-verifier.ts` (unused reference impl).

### Risk-tiered sequencing
- **`token-tracking` + `session-invalidation`** run on *events* (login, logout, moderation, data change) —
  not per-request. **Lower risk** → safe to consolidate sooner.
- **`token-refresh.refreshToken`** runs on **every authed request** — **highest risk** → do this one
  **after the hub dry-run**, against a proven baseline. Preserve `needsCookieRefresh`, the untracked-token
  self-heal, the re-mint, and the fail-open reads exactly.

### Suggested order
1. Add the two registry methods (`refreshUserSessions`, `clearMarker`) + tests.
2. Consolidate `token-tracking` + `session-invalidation` onto the registry (lower risk).
3. **After the dry-run:** rebuild `refreshToken` over `registry.getState`, keeping the glue above.
4. Delete `session-verifier.ts`.
