# `@civitai/oauth` — A Published Client Package for the Auth Hub

**Status:** not pursued (2026-10-27). Most of what this package would handle is the hub not following the
OAuth and OIDC standards, so we fixed the hub instead (`feat/oauth-standard-compliance`): standard libraries
such as `openid-client` and Auth.js now work without a Civitai package. Kept for the reasoning. **Date:**
2026-10-27.

## Why

Apps outside this monorepo can't install `@civitai/auth`: it is workspace-only (`"private": true`), and it
carries hub internals (the first-party session exchange, `firstPartyClientId`, the shared session registry) that
we don't want to support outside the repo. So an external app either writes OAuth against the hub by hand or
copies those internals. The advertising app did the second (`src/lib/server/auth/spoke-session.ts` in PR 9). A
copy like that breaks without warning when the hub changes.

The hub already speaks standard OAuth 2.0 and OIDC discovery (`/.well-known/openid-configuration`), so a generic
library can sign in against it. What a generic library doesn't know is how the hub behaves:

- **Scopes are an integer bitmask** (`scope=5`), not space-separated names. Nothing outside the repo has the
  `TokenScope` table or its labels.
- **Refresh rotates the pair with no grace period.** Two refreshes racing with the same refresh token (two pods,
  two tabs) leave one of them holding a dead token, and the user is signed out. Every client has to coordinate
  refreshes, and none does it the same way today.
- **A throttled request is a bare `429 {"error":"rate_limited"}`** with no `Retry-After`.
- **Token claims are Civitai's own:** `isModerator`, `roles`, tier, and the `BuzzBudget[]` spend limits.

`@civitai/oauth` packages that knowledge once, for any app outside the repo: our own (advertising, the CLI,
Civitai Link desktop) and third-party developers'.

## What it is, and isn't

- **It is** a client for the hub's **public OAuth contract**, the endpoints listed in discovery and documented in
  [oauth-developer-docs.md](./oauth-developer-docs.md). Nothing else.
- **It isn't** a published `@civitai/auth`. First-party sign-in (`/api/auth/oauth/session`, the shared
  `civ-token` cookie, `TrustedSpokeDomain`) stays internal to the monorepo and keeps using `@civitai/auth`.
- **It isn't** a hub change. Phases 1–3 need no hub release. Account switching (Phase 4) does.

Because the package only depends on the public contract, publishing it exposes nothing that discovery and the
developer docs don't already expose.

## Shape

One package, `packages/civitai-oauth` in this repo, published to the public npm registry as `@civitai/oauth`.
It is built from this repo, so CI tests it against the real hub routes.

| Entry point                | Contents                                                                                       | Runs on               |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------- |
| `@civitai/oauth`           | Discovery, PKCE, the flows, `TokenScope`, typed errors, id_token verification                  | Node, browser, edge   |
| `@civitai/oauth/session`   | A server-side session: an encrypted cookie, a token store and coordinated refresh             | Node / edge servers   |
| `@civitai/oauth/sveltekit` | A `handle` hook plus login, callback and logout handlers                                       | SvelteKit             |
| `@civitai/oauth/next`      | The same for Next.js route handlers and middleware (later, once an outside Next app needs it) | Next.js               |

Framework packages are optional peer dependencies, so an app installs only what it imports.

### Core (`@civitai/oauth`)

```ts
const hub = createCivitaiOAuth({
  clientId,
  clientSecret, // omit for a public client (CLI, desktop)
  redirectUri,
  issuer: 'https://auth.civitai.com', // default
});

const { url, state, verifier } = await hub.authorizeUrl({ scope: TokenScope.UserRead | TokenScope.ModelsRead });
const tokens = await hub.exchangeCode({ code, verifier });
const fresh = await hub.refresh(tokens.refreshToken);
const user = await hub.userinfo(tokens.accessToken); // typed: isModerator, roles, …
await hub.revoke(tokens.refreshToken);
// also: deviceAuthorization() + pollDeviceToken(), clientCredentials(), introspect(), verifyIdToken()
```

- **Scopes:** `TokenScope`, `tokenScopeLabels` and the bitmask helpers. They move here from
  `@civitai/auth/token-scope`, which re-exports them, so the table has one source and the hub keeps compiling
  against it unchanged.
- **Errors:** one `CivitaiOAuthError` with the OAuth `error` code. `rate_limited` is its own case, retried with
  backoff when the caller opts in.
- **Spec work:** built on [`oauth4webapi`](https://github.com/panva/oauth4webapi) (no dependencies, runs
  everywhere, follows the spec closely) rather than hand-rolled, so we own only the Civitai parts. `jose` verifies
  id_tokens against the hub's JWKS.

### Session (`@civitai/oauth/session`)

For a server-rendered app, which is what advertising needs:

- Keeps the tokens in an encrypted, HttpOnly cookie by default, or in a caller-supplied `TokenStore` (Redis,
  database) when the app runs on several pods.
- **Coordinates refresh:** single-flight within a process, plus an optional `lock` on the store across pods.
  After a lost race it re-reads the stored pair instead of refreshing again, which fixes the rotation race
  described above.
- Caches userinfo for a short time, so a role change shows up within minutes, not only at the next sign-in.

### SvelteKit adapter (`@civitai/oauth/sveltekit`)

```ts
// hooks.server.ts
export const handle = civitaiAuth({ clientId, clientSecret, redirectUri, store, require: (u) => !!u });
// login, callback and logout are served by the hook at /auth/login, /auth/callback, /auth/logout
```

It follows the convention the monorepo's SvelteKit apps already use with `createSpokeGuard` (redirect to sign in,
send a forbidden user away, otherwise set `event.locals.user`), so moving an app between first-party sign-in
and OAuth only changes the import.

## Account switching (hub work, Phase 4)

This is the gap that keeps advertising on first-party sign-in for now.

- **Today:** the hub's authorize page already has an account switcher, but a client with **Skip consent**
  (PR #6963) bypasses that page, so the switcher never appears. Outside OAuth, the hub has `/switch` and
  `/accounts`, but those only work with the first-party cookie.
- **Hub change:** support OIDC's `prompt=select_account` on `/authorize`. When it is set, show the account
  picker even for a Skip consent app, then issue a code for the chosen account. Also support `prompt=login`,
  to add another account, and `login_hint`, to pre-select one.
- **Package:** `hub.switchAccountUrl()` and a `/auth/switch` route in the adapters. The app gets a new token
  pair for the chosen account and replaces its session.
- **Later, optional:** let an app learn that the user signed out of, or switched accounts on, civitai.com. The
  options are a hub back-channel logout call to the app, or a check on each refresh. Neither is needed to ship
  switching.

## Releasing

- **Versions:** semver, tagged `oauth-vX.Y.Z`, as the hub release does with `auth-app-vX.Y.Z` (see
  [releasing.md](./releasing.md)). Any change to the public contract is a major version.
- **Publishing:** a GitHub Actions workflow publishes on the tag with npm trusted publishing (OIDC, with
  provenance), so no long-lived npm token is stored anywhere.
- **Contract tests:** the package's tests run in CI against the hub's own route handlers, so a hub change that
  would break published clients fails the hub PR, not an app in production.

## Phases

1. **Core.** Create the package, move `TokenScope` into it, wrap the flows, write the error types, and add
   contract tests. Publish `0.1.0`.
2. **Session and SvelteKit adapter.** Encrypted-cookie and store-backed sessions, coordinated refresh, the
   `handle` hook. Try it on advertising behind a flag.
3. **Docs and other consumers.** An SDK quick start in `oauth-developer-docs.md`. Move the CLI and Civitai Link
   desktop onto the core, if they gain from it.
4. **Account switching.** The hub's `prompt=select_account`, then `switchAccountUrl()` and the adapter route.
   Once this ships, advertising moves from first-party sign-in to a system OAuth app (see
   [choosing-sign-in-for-an-app.md](./choosing-sign-in-for-an-app.md)) and deletes `spoke-session.ts`.
5. **Next.js adapter**, when an app outside the repo needs it.

## Open questions

1. **Does Civitai own the `@civitai` scope on npm?** The unscoped `civitai` package exists (maintained by Justin)
   and `@civitai/oauth` is unclaimed, but whether the scope is ours needs checking with an npm org owner.
2. **`oauth4webapi`, or our own small implementation?** The plan picks the library to stay closer to the spec. The
   cost is one dependency we don't control.
3. **Named scopes.** Should the hub also accept space-separated scope names (`scope=UserRead ModelsRead`)?
   Standard libraries would then work unchanged. The package hides the bitmask either way.
4. **Does the CLI gain enough to switch?** It already has a working device flow.
