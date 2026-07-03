# App Blocks (Phase 1)

Third-party iframe-embedded blocks that render on civitai model pages,
authenticated via short-lived RS256 JWTs scoped to a single block install.

## Concepts

- **Block**: a hosted iframe (`https://blocks.civitai.com/<name>` or
  partner-controlled origin in v2) declared by a manifest. Owned by an
  OauthClient (app).
- **Install**: a row in `model_block_installs` pinning one block to one
  (model, slot). Publisher-controlled.
- **Slot**: a named region on a model page where blocks render. Only three
  ship in v1: `model.sidebar_top`, `model.below_images`, `model.actions_extra`.
- **Platform default**: a `platform_default_blocks` row promoting one
  block to render on every eligible model that hasn't opted out.
- **BlockInstanceId**: per-install identifier (`bki_<ulid>`) — the primary
  key for tokens, revocation, and ownership checks.

## Tables

| Table                     | Purpose                                  | Notable invariants                                                                     |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `app_blocks`              | Registry of every block across every app | `status='pending'` until moderated; `trustTier` and `renderMode` are server-controlled |
| `model_block_installs`    | Per-(model, slot) installs               | Unique on `(model_id, app_block_id, slot_id)`; max 3 installs per slot                 |
| `block_user_settings`     | Per-(viewer, instance) prefs (Phase 2)   | CASCADE on install delete + GDPR user delete                                           |
| `platform_default_blocks` | Promoted defaults                        | Filtered by `target_model_types` + content rating + ordered by `priority`              |

## Tokens

- RS256, signed by `BLOCK_TOKEN_PRIVATE_KEY`, verified via JWKS.
- 15-minute lifetime by default; 5-minute lifetime for `block:settings:*` scopes.
- Claims: `iss`, `aud`, `sub` (`user:<id>` or `anon`), `iat`, `nbf`, `exp`,
  `jti`, `blockId`, `appId`, `blockInstanceId`, `ctx`, `scopes`,
  `buzzBudget?`.
- Per-instance revocation via `BlockRevocation` service — uninstall and
  toggleEnabled(false) write a marker; toggleEnabled(true) clears it.

## Scopes

See `src/shared/constants/block-scope.constants.ts`. Each block scope maps
to an OAuth bitmask bit (registration-time gate), plus a context-binding
check at request time (`enforceContextBinding`).

| Scope                            | Bind                                              | Notes                             |
| -------------------------------- | ------------------------------------------------- | --------------------------------- |
| `models:read:self`               | `query.id == ctx.modelId`                         |                                   |
| `media:read:owned`               | non-anon `sub`                                    |                                   |
| `buzz:read:self`                 | non-anon `sub`                                    |                                   |
| `social:tip:self`                | non-anon `sub`                                    |                                   |
| `user:read:self`                 | non-anon `sub`                                    | `/api/v1/blocks/me`               |
| `ai:write:budgeted`              | positive `buzzBudget`                             |                                   |
| `block:settings:read` / `:write` | `query.blockInstanceId == claims.blockInstanceId` | + caller-is-installer at issuance |

Unknown scopes are rejected at runtime (deny-by-default in middleware).

## Routes

| Route                                          | Auth                 | Scope required                  |
| ---------------------------------------------- | -------------------- | ------------------------------- |
| `POST /api/v1/block-tokens`                    | same-origin session  | — (any approved install)        |
| `GET /api/v1/block-tokens/jwks`                | public               | —                               |
| `GET /api/v1/blocks/me`                        | block JWT            | `user:read:self`                |
| `GET /api/v1/models/[id]`                      | session OR block JWT | `models:read:self` (block path) |
| `POST /api/v1/developer/block-manifests`       | `JOB_TOKEN`          | —                               |
| `POST /api/internal/blocks/workflow-completed` | `JOB_TOKEN` + Flipt  | —                               |

## Feature flag

`appBlocks` (Flipt key: `app-blocks-enabled`) gates the BlockSlot mount
on model pages AND `/api/internal/blocks/workflow-completed`. Off by
default. The per-block emergency kill list
(`system:blocks:emergency-kill-list` SET in sys Redis) is the
fine-grained tool for ops.

## Threat model highlights

- **Iframe sandbox** is the primary isolation. Sandbox token allowlist is
  trust-tier gated; `allow-same-origin` is internal-only.
- **CORS** on `/api/v1/block-tokens` is same-origin only (exact-host
  match). Block iframes never call this endpoint; the host page fetches
  and passes the token via `BLOCK_INIT`.
- **CSRF**: closed by the same-origin lockdown. A future change that
  reopens cross-origin issuance must bring its own CSRF mitigation.
- **SSRF**: manifest `iframe.src` and `assetBundleUrl` are lexically
  rejected for private/internal hosts (RFC1918, link-local,
  loopback, IPv6 ULA fc00::/7, encoded IP literals,
  `.internal`/`.local`/`metadata.*` reserved names, IPv6 zone
  identifiers, literal IPs). DNS-rebinding is a Phase 2 fetch-time
  validation concern.
- **Token replay**: per-instance revocation set in Redis. Per-jti
  denylist deferred (heavier infra, equivalent outcome at v1 volumes).
- **Ownership escalation**: `block:settings:*` tokens require caller
  is the install's `installedByUserId` at issuance. The check is
  authoritative at issue time; deleted-publisher installs (FK SET NULL)
  fail closed.

## BLOCK_INIT contract

The host posts a single `BLOCK_INIT` message once the iframe has loaded AND
the token endpoint has resolved. Matches `@civitai/app-sdk/blocks` v1:

```ts
{
  blockInstanceId: string;
  blockId: string;
  appId: string;
  token: {
    raw: string;                       // RS256 JWT
    scopes: string[];                  // from manifest, e.g. ['models:read:self']
    expiresAt: string;                 // ISO-8601
    buzzBudget?: number;               // only when manifest includes ai:write:budgeted
  };
  context: SlotContext;                // slotId + per-surface fields
  settings: {
    publisherSettings: Record<string, unknown>;  // model_block_installs.settings
    userSettings: Record<string, unknown>;       // empty in v1; Phase 2 populates
  };
  viewer: {
    id: number;
    username: string | null;
    // NOTE: moderation `status` (ban/mute) is intentionally NOT sent to the
    // iframe — no block consumes it and it's a viewer-privacy leak. A block's
    // authoritative check is its own /api/v1/blocks/me call.
  } | null;                            // null for anon viewers
  theme: 'light' | 'dark';             // matches host color scheme
  renderMode: 'iframe' | 'inline';     // always 'iframe' in v1
}
```

### Token refresh

Two flows, both delivering the same wrapped-token shape:

1. **Host-pushed**: when the host refreshes the token (~13 min cadence) the
   iframe receives `TOKEN_REFRESH` with the new `token` object. No user
   action required.
2. **Iframe-initiated**: the iframe sends `REQUEST_TOKEN` (optionally with a
   `requestId`) and the host replies with `TOKEN_REFRESH_RESPONSE` carrying
   the current token. Useful right before an expensive orchestrator call.

### What's NOT host-brokered

By design, blocks call the **civitai-orchestration** API directly with their
JWT for workflows. The orchestrator validates via the JWKS endpoint and
buckets buzz spend by the token's `buzzBudget` claim. This keeps the host
out of the request path on every generation.

Several later postMessage surfaces have since landed: `OPEN_BUZZ_PURCHASE` /
`GET_BUZZ_BALANCE` (host-mediated Buzz purchase + per-account balance read) and
`NAVIGATE` (page host only — the model slot intentionally does not bridge it).
`TRACK_EVENT` is still not host-bridged (no analytics sink wired) and is dropped
silently. See `src/components/AppBlocks/hostHandlerParity.ts` for the
authoritative host↔SDK message inventory. The SDK should detect an unhandled
surface gracefully.

## Publish / review / deploy lifecycle (no trust on push)

The build + deploy of new iframe code is gated entirely on **moderator
approval**, never on a git push:

1. **submitVersion** (dev) — uploads a ZIP bundle. Validates the manifest,
   inserts an `app_block_publish_requests` row `status='pending'`, pushes the
   bundle to the _review_ org (`civitai-apps-review/<slug>`, NOT the build
   org). Nothing builds or deploys.
2. **approveRequest** (moderator, `/apps/review`) — re-validates the manifest,
   creates/updates the `app_blocks` row, commits the reviewed bundle to the
   _build_ org (`civitai-apps/<slug>:main`), **stamps the committed sha onto
   `app_blocks.current_version_sha`**, finalises the publish request
   (`status='approved'`, `forgejo_commit_sha=<sha>`), and **triggers the Tekton
   build itself**. → build-callback → apply Job → deploy.
3. **git-push webhook** (`/api/internal/blocks/git-push`) — fires on every push
   to `civitai-apps/<slug>:main`, including the moderator's commit from (2).
   It **never auto-approves and never triggers a build**:
   - If the pushed sha is the moderator-approved one
     (`sha === current_version_sha`, or an `approved` publish request matches the
     sha as a race backstop) → no-op; the deploy is already in flight from (2).
   - Any **other** push (a direct push to the build repo by someone with Forgejo
     write access — a _different trust domain_ than civitai moderation) is
     treated as unreviewed: it is recorded as a `pending` publish request for the
     pushed sha (the same review artifact a submitVersion produces) and **does
     not deploy**. A moderator must approve it via (2) before it ships.

This closes the trust-on-push hole: a signature-valid push can no longer ship
arbitrary iframe code to a live, mod-page-embedded block. The HMAC signature,
the `civitai-apps` org/repo gate, the `app-blocks-enabled` flag gate, and
manifest validation are all still enforced on the webhook.

> Note: a webhook-recorded pending request has empty bundle pointers
> (`bundle_key=''`, `bundle_sha256=''`) — the webhook only receives the push
> event + the manifest, not the ZIP. The reviewable artifact is the Forgejo repo
> at `forgejo_commit_sha`; mods browse it directly. `approveRequest` approves
> against the existing `app_blocks` row + re-commits the (already-present) repo
> contents.

## Publisher-side notes

### Manifest re-publish behavior

Every change to the manifest body (anything other than a byte-equal re-post)
resets `app_blocks.status` to `pending`. The block stops rendering until a
moderator re-approves. This includes **bumping `version`** even if nothing
else changes semantically — a version bump IS the publisher's signal that
something changed, and moderators get a chance to re-review.

CI pipelines that re-upload on every deploy should either:

- Keep `version` stable across no-op pushes (byte-equal short-circuit returns
  `{ unchanged: true, status: <prior> }`); or
- Accept the latency between push and re-approval.

`trustTier` and `renderMode` are NEVER changed by manifest upload — those
are admin-controlled fields. Any value supplied in the manifest body is
ignored on insert (forced to `unverified`/`iframe`) and 403'd on update
if it differs from the current row.

`iframe.src` is also platform-owned: the only valid value is the per-app
subdomain root (`https://<slug>.<APPS_DOMAIN>/`), so the developer **omits it**
and the platform stamps it from the slug at submit + approve + git-push (see
`server/services/blocks/manifest-normalize.ts`). Any dev-supplied `iframe.src`
is overwritten. Other `iframe` fields (`minHeight`, `sandbox`) stay
developer-authored. This is why a developer never has to hand-author a
subdomain that doesn't exist until their app is approved.

### Bundle contents

A submitted ZIP needs only **`block.manifest.json`** at the root plus your app
(`index.html` + `src/` + whatever your build emits). A `Dockerfile` /
`nginx.conf` are **not required** — the build pipeline injects its own
platform-owned recipe and ignores (and drops) any tenant-supplied build files
(audit A8/BUILD-1 Phase 2). Shipping them is harmless but inert.

## Known gaps before Phase 2 admin tool ships

### Cache invalidation on `app_blocks.status` transitions (audit-10 H3)

`BlockRegistry.listForModel` caches results for 60 seconds and the SQL
only filters on `ab.status = 'approved'` at query time, not at
cache-read time. `invalidateModelCache` fires from install / uninstall
/ toggle / updateSettings paths — but NOT when a moderator transitions
`app_blocks.status` (`approved` → `suspended` / `deprecated`).

Result: a freshly-suspended block continues rendering on every model
where it was previously cached for up to 60s. The emergency kill list
is the v1 escape hatch for "stop this block right now"; suspension is
the slower-cadence path that needs proper invalidation before the
admin approval workflow lands.

Phase 2 admin tool must do one of:

- Issue a global cache flush across `REDIS_KEYS.BLOCKS.REGISTRY:*` on
  status change (Lua `SCAN`-then-`DEL`), or
- Include `status_revision` in the cache key so suspension forces a
  miss without an explicit flush.

Until then, ops uses the emergency kill list (`sysRedis SET
system:blocks:emergency-kill-list`) to take a runaway block down.

### Feature-flag launch posture (audit-10 M2)

`appBlocks` (Flipt key `app-blocks-enabled`) is registered with
`availability: ['mod']`. Non-moderators get `features.appBlocks ===
false` regardless of the Flipt flag, so the substrate is effectively
mod-canary until that availability is widened to `['public']`.

This is intentional for v1 launch — Flipt is the kill switch; the
availability gate is the canary posture. Flip to `['public']` when
launching generally.

## Phase 2 / 3 follow-ups

- Publisher install UX (model-edit tab).
- Moderator approval workflow + admin-only tier-change tool.
- ClickHouse telemetry: `block_renders`, `block_interactions`,
  `block_workflows`.
- Health-check job + auto-suspend on consecutive failures.
- Per-jti denylist if v2 volumes change the cost trade.
- Audit log table for install/uninstall/settings-change/manifest-upsert.
- CSP `frame-src` on model pages (defense-in-depth).
- Per-app OAuth replacing `JOB_TOKEN` for manifest registration.
- DNS-rebinding gate at `assetBundleUrl` fetch time.
- Per-block-instance install-cap race hardening (transaction with row
  lock vs. accept the rare race).
