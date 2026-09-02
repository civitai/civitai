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
| `origin`, `createdAt` | provenance |

The OAuth pairing path adds one more column on the link-service side, not surfaced in the site's
type: `installId`, the desktop app's per-install uuid. `(userId, installId)` is unique, so
re-pairing the same install re-keys it instead of adding a row.

**The key length is load-bearing.** The socket layer treats a **short key (< 10 chars)** as a
not-yet-upgraded pairing code, and a **long key (128 hex)** as an activated instance. It kicks the
room when the second party joins if that does not match `activated` — a short key must have
`activated: false`, a long key `activated: true`. This is why the OAuth path creates instances with
a full-length key and `activated: true` in one step.

`INSTANCE_LIMIT` (link-service, default 10) caps instances per user; both create paths are
count-then-create.

## Pairing: the desktop app (OAuth device grant)

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
   bitmask, then upserts the instance on `(userId, installId)` with a fresh 128-hex key and
   `activated: true`. It returns `{ id, key, name }`.
5. The app persists the key and joins the socket room. The socket protocol is unchanged.

The Bearer token is used **once**, at pairing. link-service caches nothing. If the hub is
unreachable a new pairing fails with a 503; already-connected apps are untouched.

Why introspection rather than a signed grant: the access token is opaque (`civitai_` + 36 random
chars, only a salted SHA-512 hash stored), so link-service cannot verify it locally. See
[../auth/oauth-developer-docs.md#token-introspection](../auth/oauth-developer-docs.md#token-introspection).

`LinkConnect` is bit 27 of the shared scope bitmask
([`packages/civitai-auth/src/token-scope.ts`](../../packages/civitai-auth/src/token-scope.ts)). It
is opt-in: excluded from `Full`, from every preset, and from the personal-API-key permissions grid,
so no existing key carries it.

## Pairing: the ComfyUI node pack (six-character code)

Unchanged, and staying. The node pack cannot run a device grant, so the wizard's node-pack path
still calls `POST /api/link` to mint a six **hex character** code, shows it, and the user pastes it
into the ComfyUI panel. The short key is upgraded to a 128-hex key when the two sockets meet.

Already-paired desktop apps from before 1.21.0 keep working: the socket inspects nothing but the
key.

## The site's polling contract

The site never learns about a pairing from a push. It polls:

- `GET /api/link` → the user's instances (`getLinkInstances`).
- `POST /api/link` → mint an instance/code (`createLinkInstance`). Node-pack path only.
- `PUT /api/link` → rename (`updateLinkInstance`).
- `DELETE /api/link?id=` → remove (`deleteLinkInstance`).

All four go through `clFetch`, which sends `credentials: 'include'` — link-service authenticates the
browser with the **civitai session cookie**, so the base URL must be same-registrable-domain.
`getCivitaiLinkBaseUrl()` rewrites `.civitai.com` → `.civitai.red` for `.red` hosts and returns
`undefined` for any other origin (PR previews, `civitai.green`), where the cookie could never
arrive; callers disable the feature rather than fire a request that always 401s.

Once an instance is selected the shared worker joins its room by key and the connection is a
socket, not polling.

> The link-service half (`POST /api/link/self`, the Bearer path, the `installId` column) ships in
> its own PR in that repo. The "sign in from the app" wizard step, the worker's await-pairing
> message, and the popover's reconnect copy for OAuth-paired instances land in a **second PR here**,
> after the desktop release, so the copy matches a shipped app.

## Design record

Full design, sequencing, and the accepted caveats:
[`docs/superpowers/specs/2026-09-01-civitai-link-oauth-design.md`](../superpowers/specs/2026-09-01-civitai-link-oauth-design.md).
