# Civitai Link

Civitai Link connects a user's local Stable Diffusion install to civitai.com, so the site can send
a model to their machine and show what is already installed. Two clients speak it: the **Civitai
Link desktop app** (`civitai-link-desktop`, Electron) and the **ComfyUI node pack**
(`civitai-comfy-nodes`). The service in the middle is **link-service** (`link.civitai.com`); this
repo holds the site half.

## Pieces

| Piece | Where |
|---|---|
| Site REST client | [`src/components/CivitaiLink/civitai-link-api.ts`](../../src/components/CivitaiLink/civitai-link-api.ts) |
| Shared socket worker | [`src/workers/civitai-link.worker.ts`](../../src/workers/civitai-link.worker.ts) |
| React context + hooks | [`src/components/CivitaiLink/CivitaiLinkProvider.tsx`](../../src/components/CivitaiLink/CivitaiLinkProvider.tsx) |
| Setup wizard | [`src/components/CivitaiLink/CivitaiLinkWizard.tsx`](../../src/components/CivitaiLink/CivitaiLinkWizard.tsx) |
| Status / manage popover | [`src/components/CivitaiLink/CivitaiLinkPopover.tsx`](../../src/components/CivitaiLink/CivitaiLinkPopover.tsx) |
| Command + response types | [`src/components/CivitaiLink/shared-types.ts`](../../src/components/CivitaiLink/shared-types.ts) |
| link-service, socket, instance rows | the `link-service` repo (not here) |

## The instance model

An **instance** is one paired client. link-service owns the row; the site sees it through
`GET /api/link`, typed as `CivitaiLinkInstance` in `civitai-link-api.ts`:

| Field | Meaning |
|---|---|
| `id` | link-service's row id — the site's stable handle for a client |
| `key` | the shared secret **and** the socket room name |
| `name` | user-editable label |
| `activated` | whether the key has been upgraded to its long form |
| `oauthPaired` | paired by sign-in — decides whether a stalled instance is told to sign in again or to re-key with a code |
| `origin`, `createdAt` | provenance |

One more column lives on the link-service side and is not surfaced: `installId`, the client's
per-install uuid. `(userId, installId)` is unique, so re-pairing the same install re-keys it instead
of adding a row.

**The key length is load-bearing.** The socket layer uses it to distinguish a not-yet-upgraded
pairing code from an activated instance, which is why the OAuth path creates instances with a
full-length key and `activated: true` in one step.

`INSTANCE_LIMIT` (link-service, default 10) caps instances per user, counted before each create.

## Pairing: the desktop app (OAuth device grant)

> **Shipped.** Desktop `v1.21.0` (2026-09-07) pairs this way. The node pack pairs through the
> account too from `v0.6.0` (2026-09-05), but by authorization code — see
> [the node-pack section](#pairing-the-comfyui-node-pack-oauth-authorization-code).
>
> **Three things have to happen per environment**, none of them automatic:
>
> - The `civitai-link-desktop` client row is applied by hand — migrations here are never auto-run —
>   and only after the hub deploy that ships `LinkConnect`, or the requested scope is rejected. The
>   node pack's client is registered out of band and needs `LinkConnect` in its `allowedScopes` the
>   same way; no file in this repo creates or widens it, and until it does the pack gets
>   `invalid_scope` and falls back to a code.
> - A **confidential** `link-service` OAuth client is registered out of band. Its secret cannot live
>   in a migration, so no file in this repo creates it.
> - That client's id is added to the hub's `OAUTH_INTROSPECTION_CLIENT_IDS`. The allowlist fails
>   closed: unset or stale, every introspection call gets a flat `401 invalid_client`, indistinguishable
>   from a bad secret. Check it first when a service that was introspecting stops.

From Civitai Link 1.21.0 the desktop app never shows a code. It signs in.

1. The app requests a device code from the hub with
   `client_id=civitai-link-desktop` and
   `scope = UserRead | VaultRead | VaultWrite | LinkConnect` = `159383553`, then opens
   `verification_uri_complete` in the system browser. The user approves.
   (The device grant force-adds `UserRead`, so the consent screen lists profile access too.)
2. The app polls the device-token endpoint at `interval` seconds. Over-polling returns HTTP `429`
   `{"error":"rate_limited"}` — there is no `slow_down` — and the app adds 5 s to its interval.
3. The app calls `POST {link}/api/link/self` with `Authorization: Bearer <access_token>` and
   `{ installId, name }`.
4. link-service calls `POST {hub}/api/auth/oauth/introspect` with its own confidential client
   credentials, requires `active: true` **and** the `LinkConnect` bit in the returned `scope`
   bitmask, then upserts the instance on `(userId, installId)` with a fresh full-length key and
   `activated: true`. It returns `{ id, key, name }`.
5. The app persists the key and joins the socket room. The socket protocol is unchanged.

`active: true` already means the account is in good standing — the hub answers `active: false` for a
closed or suspended owner — so link-service needs no second check beyond the `LinkConnect` bit.

The Bearer token is used **once**, at pairing. link-service caches nothing. If the hub is
unreachable a new pairing fails with a 503; already-connected apps are untouched.

**The app must call `/token` and `/revoke` from the Electron main process.** `civitai-link-desktop` is
registered with an empty `allowedOrigins`, and both endpoints answer `403 origin_not_allowed` to a
public-client request that carries an `Origin` header; a request that sends none — which is what the
main process does — is allowed. Pairing itself is unaffected, because the device endpoints have no
origin gate, so the symptom would surface later: the first token refresh, or sign-out revocation.
Calling either from a renderer would require adding its origin to the client's `allowedOrigins`.

Why introspection rather than a signed grant: the access token is opaque (`civitai_` + 36 random
chars, only a salted SHA-512 hash stored), so link-service cannot verify it locally. See
[../auth/oauth-developer-docs.md#token-introspection](../auth/oauth-developer-docs.md#token-introspection).

`LinkConnect` is bit 27 of the shared scope bitmask
([`packages/civitai-auth/src/token-scope.ts`](../../packages/civitai-auth/src/token-scope.ts)). It
is opt-in: excluded from `Full`, from every preset, and from the personal-API-key permissions grid,
so no existing key carries it.

## Pairing: the ComfyUI node pack (OAuth authorization code)

From node pack `0.6.0` the pack pairs through the user's account too
([civitai-comfy-nodes#19](https://github.com/civitai/civitai-comfy-nodes/pull/19)). It runs a
loopback PKCE flow against the hub rather than a device grant — the sign-in that authenticates the
pack's own API calls requests `LinkConnect` as well, and `/civitai/auth/login` pairs Link right
after, so one sign-in covers both. An already-signed-in pack offers **Pair this ComfyUI** instead.

From there it is the desktop flow verbatim: `POST {link}/api/link/self` with the access token,
`installId` from `~/.civitai/comfy-install-id`, and link-service introspects at the hub. A pack that
was already paired with a code sends that key as `legacyKey`, so link-service adopts the existing
row rather than adding a second one.

`LINK_SCOPE` is only requested when the pack runs under the official client id — the hub answers
`invalid_scope` to a request wider than a client's `allowedScopes`, so a self-registered
`CIVITAI_OAUTH_CLIENT_ID` (the app-settings UI caps at `Full`) can only pair with a code.

### The six-character code, and why it stays

Both clients now sign in, so the wizard leads with the wait for both. The code is the fallback the
wizard offers behind a link on the node-pack path only, for the two cases account pairing cannot
reach:

- **ComfyUI on another machine.** The PKCE callback is a loopback URI, so the browser approving the
  sign-in resolves `localhost` to the user's own machine, not the ComfyUI host.
- **A node pack older than `CIVITAI_LINK_NODE_PACK_MIN_VERSION`** (`0.6.0`, in
  [`civitai-link-paths.ts`](../../src/components/CivitaiLink/civitai-link-paths.ts)), which has no
  account pairing at all.

(The pack also keeps it for API-key connections, which carry no OAuth token to introspect.)

Already-paired clients from before either release keep working: the socket inspects nothing but the
key.

## The site's polling contract

The site never learns about a pairing from a push. It polls:

- `GET /api/link` → the user's instances (`getLinkInstances`).
- `POST /api/link` → mint an instance/code (`createLinkInstance`). Code pairings only: the wizard's
  fallback link, and the popover's **Reconnect** re-key for a code-paired instance.
- `PUT /api/link` → rename (`updateLinkInstance`).
- `DELETE /api/link?id=` → remove (`deleteLinkInstance`).

All four go through `clFetch`, which sends `credentials: 'include'` — link-service authenticates the
browser with the **civitai session cookie**, so the base URL must be same-registrable-domain.
`getCivitaiLinkBaseUrl()` rewrites `.civitai.com` → `.civitai.red` for `.red` hosts and returns
`undefined` for any other origin (PR previews, `civitai.green`), where the cookie could never
arrive; callers disable the feature rather than fire a request that always 401s.

Once an instance is selected the shared worker joins its room by key and the connection is a
socket, not polling.

## Design record

Full design, sequencing, and the accepted caveats: [ClickUp
`868kyynkb`](https://app.clickup.com/t/868kyynkb).
