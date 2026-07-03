# Civitai Apps

> Product name: **Civitai Apps** (historically "App Blocks"). The user-facing copy
> is "Apps"; the codebase, tables, scopes, and message names still use `block` /
> `app_block` — that technical vocabulary is retained throughout this doc on
> purpose (a "block" is the hosted iframe unit an app ships).

Third-party iframe-embedded **blocks** that render on civitai model pages and as
full-page apps, authenticated via short-lived RS256 JWTs scoped to a single block
install. Each app is served from its own platform-owned subdomain
(`https://<slug>.civit.ai/`).

## Concepts

- **Block**: a hosted iframe served from the app's platform-owned subdomain
  (`https://<slug>.civit.ai/`, where the root is `APPS_DOMAIN`, default
  `civit.ai`), declared by a manifest and owned by an OauthClient (app). The
  `iframe.src` is platform-stamped from the slug — a developer never authors it
  (see `server/services/blocks/manifest-normalize.ts`).
- **Install**: a row in `model_block_installs` pinning one block to one
  (model, slot). Publisher-controlled.
- **Slot**: a named region where a block renders. Model-page slots include
  `model.sidebar_top`, `model.below_images`, and `model.actions_extra`. A block
  can also run as a full-page app via the page host at `/apps/run/<slug>`
  (`PageBlockHost.tsx`) — a distinct host surface with its own message-handler
  requirements (see the message inventory below).
- **Platform default**: a `platform_default_blocks` row promoting one
  block to render on every eligible model that hasn't opted out.
- **BlockInstanceId**: per-install identifier (`bki_<ulid>`) — the primary
  key for tokens, revocation, and ownership checks.

## Tables

| Table                     | Purpose                                  | Notable invariants                                                                     |
| ------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `app_blocks`              | Registry of every block across every app | `status='pending'` until moderated; `trustTier` and `renderMode` are server-controlled |
| `model_block_installs`    | Per-(model, slot) installs               | Unique on `(model_id, app_block_id, slot_id)`; max 3 installs per slot                 |
| `block_user_settings`     | Per-(viewer, instance) prefs             | CASCADE on install delete + GDPR user delete; populated e.g. by `SET_USER_CHECKPOINT`  |
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
| `block:settings:read` / `:write` | `query.blockInstanceId == claims.blockInstanceId` | + caller-is-installer at issuance; `SKIP_OAUTH_CHECK` |
| `apps:storage:read` / `:write`   | scope present on `claims.scopes` per op           | per-app KV store (App Storage); no OAuth bit (`SKIP_OAUTH_CHECK`) — gated by the approved-scope snapshot + `resolveStorageContext` |

Unknown scopes are rejected at runtime (deny-by-default in middleware).

> There is intentionally **no** `catalog:read` scope. The block catalog endpoints
> (`/api/v1/blocks/models`, `/api/v1/blocks/images`) serve public, maturity-clamped
> data and accept any valid block token for its signed `maxBrowsingLevel` claim, not
> for authorization (`catalog:read` was added in #2671 and retired the next day).

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
    userSettings: Record<string, unknown>;       // per-viewer prefs from block_user_settings (e.g. SET_USER_CHECKPOINT)
  };
  viewer: {
    id: number;
    username: string | null;
    // NOTE: moderation `status` (ban/mute) is intentionally NOT sent to the
    // iframe — no block consumes it and it's a viewer-privacy leak. A block's
    // authoritative check is its own /api/v1/blocks/me call.
  } | null;                            // null for anon viewers
  theme: 'light' | 'dark';             // matches host color scheme
  renderMode: 'iframe' | 'inline';     // always 'iframe' today (the inline host is a stub)
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

### Block↔host message inventory

Blocks do **not** call the orchestrator directly. Generation and every other
privileged capability is **host-brokered**: the iframe posts a typed message to
its host, the host performs the action server-side against a block-token-authed
tRPC mutation (which re-verifies the JWT and re-checks scopes/maturity), and the
host posts the reply back. This keeps the block token in POST bodies (never in a
GET URL) and keeps policy enforcement on the platform side of every call.

**The single source of truth for the message set is
`src/components/AppBlocks/hostHandlerParity.ts`** — a compile-time-enforced
inventory of every block→host message, which hosts must handle it, and whether
it is REQUEST-style (awaits a `*_RESULT`/ack reply — an unhandled one hangs the
block) or fire-and-forget. Rather than duplicate a list here that will re-drift,
read that file. As of this writing the families are:

- **Lifecycle** (fire-and-forget): `BLOCK_READY`, `BLOCK_ERROR`, `RESIZE_IFRAME`.
- **Auth / consent**: `REQUEST_TOKEN` (→ `TOKEN_REFRESH_RESPONSE`),
  `REQUEST_SIGN_IN`, `REQUEST_CONSENT`.
- **Workflows** (REQUEST-style, host-brokered via `blocks.submitWorkflow` /
  `estimateWorkflow` / `pollWorkflow`): `SUBMIT_WORKFLOW`, `ESTIMATE_WORKFLOW`,
  `POLL_WORKFLOW`, `CANCEL_WORKFLOW`.
- **Buzz**: `OPEN_BUZZ_PURCHASE` (host-mediated purchase) and `GET_BUZZ_BALANCE`
  (per-account balance read — see below).
- **Resource pickers** (host chrome so the iframe only learns the one resource the
  user picked): `OPEN_CHECKPOINT_PICKER` (model slot) and the wider
  `OPEN_RESOURCE_PICKER` (page host only). `SET_USER_CHECKPOINT` persists to
  `block_user_settings` (model-bound installs only).
- **App Storage** (per-app KV; `apps:storage:*` scopes): `APP_STORAGE_GET` /
  `_SET` / `_DELETE` / `_LIST` / `_QUOTA`.
- **Navigation**: `NAVIGATE` — page host only; the model slot intentionally does
  not bridge it (an embedded panel navigating the host away is out of remit).
- **Analytics**: `TRACK_EVENT` — fire-and-forget, **not** host-bridged by either
  real host today (no analytics sink wired), so it is silently dropped (never
  hangs the block). Flip the host entries to `required` in the inventory if/when
  a sink lands.

The `SUSPEND` / `RESUME` messages flow the other direction (parent→block). The
SDK degrades gracefully when a host does not handle a fire-and-forget surface.

### Buzz and per-account spend

Civitai Buzz is split into spendable pools — **blue** (purchased), **green**
(earned), and **yellow** (creator-program) — and blocks are per-account aware:

- **Read balance**: the host answers `GET_BUZZ_BALANCE` from the block-token-authed
  `blocks.getMyBuzzBalance` mutation, which returns `{ blue, green, yellow }` for
  the token's subject (other account types — red / cash / creator-program — are
  omitted). This backs the SDK `useBuzzBalance()` hook + the account picker.
- **Choose the funding pool**: a workflow submit body may carry `accountType`
  (`blue | green | yellow`). It is honored **preferred-first** while the maturity
  policy clamp still applies (a SFW-domain block can't widen to a mature currency);
  an out-of-set pick is rejected, absent → Auto (see
  `resolveBlockCurrenciesForAccount`).
- **Which pool actually paid**: the workflow status snapshot carries
  `spentAccountType` — the `accountType` of the largest *realized* debit — so a
  block can attribute spend after the fact (internal-only accounts are omitted).

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

> This section predates the shipped moderator review workflow (see "Publish /
> review / deploy lifecycle" above — `/apps/review`, `approveRequest`). Some of
> the "Phase 2 admin tool" premises here are now partly satisfied; the cache-
> invalidation-on-`status`-transition gap below should be re-verified against
> current `BlockRegistry` behavior before relying on it. Needs a maintainer pass.

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

> Partly stale — several items below have since shipped (the moderator approval
> workflow and per-app KV / App Storage among them). Treat this as a historical
> backlog; confirm each item's live status before acting on it. Needs a
> maintainer pass to prune the completed rows.

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
