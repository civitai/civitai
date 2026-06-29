# App Blocks host↔SDK handler parity audit (2026-06-29)

## The bug class (gotcha-#73 — "spins forever, no network call, no console error")

App Blocks has multiple host components that bridge block→host `postMessage`s, each
registering its own `onMessage('<TYPE>', …)` handlers BY HAND:

- `src/components/AppBlocks/IframeHost.tsx` — model-slot host (`model.sidebar*` slots)
- `src/components/AppBlocks/PageBlockHost.tsx` — full-page run host (`civitai.com/apps/run/<slug>`)
- `src/components/AppBlocks/InlineHost.tsx` — inline host (v1 STUB: throws on render, NO message bridge)

The SDK (`@civitai/app-sdk` / `@civitai/blocks-react`) sends two flavours of block→host message:

- **REQUEST-style** — the hook uses `sendTypedRequest(...)` and AWAITS a specific `*_RESULT`/ack
  reply. If the host has NO handler, the request never gets a reply → the block hangs to its SDK
  request timeout → the UI spins forever, **no network call, no console error**. This is the
  dangerous class.
- **fire-and-forget** — the hook uses `sendMessage(...)` and awaits nothing. An unhandled one is
  silently dropped (a no-op), which never hangs the block.

The dev:live SDK host (`createLiveHost` / `liveHost.ts` in the separate `civitai-app-starters`
repo) serves these messages, so authors test green locally then break in prod — a fidelity gap.
This exact gap bit `OPEN_CHECKPOINT_PICKER` on pages (a page block's `useCheckpointPicker()`
"Change model" spun forever) — fixed in the now-merged civitai #2799.

## Source of truth

- Message protocol union: `@civitai/app-sdk` `blocks/messages.ts` → `BlockToParentMessage`
  (verified against the installed `node_modules/@civitai/app-sdk/dist/blocks/messages.d.ts` AND
  the newer `civitai-app-starters` source — the starters source additionally carries
  `CANCEL_WORKFLOW` / `REQUEST_SIGN_IN` / `REQUEST_CONSENT`, all already in the union below).
- REQUEST vs fire-and-forget: derived from the `@civitai/blocks-react` hooks — `sendTypedRequest`
  (REQUEST) vs `getTransport().sendMessage` (fire-and-forget). Verified per hook.

## Coverage matrix (verified 2026-06-29)

`✅` = `onMessage('<TYPE>')` registered (read in source, multi-line handlers included).
`N/A` = legitimately not handled (rationale). `❌` = a real gap.

| # | Message (block→host) | Style | Reply awaited | IframeHost | PageBlockHost | InlineHost |
|---|---|---|---|---|---|---|
| 1 | `BLOCK_READY` | fire-forget | — | ✅ | ✅ | N/A (v1 stub) |
| 2 | `BLOCK_ERROR` | fire-forget | — | ✅ | ✅ | N/A (v1 stub) |
| 3 | `RESIZE_IFRAME` | fire-forget | — | ✅ | **N/A** (page iframe is full-viewport `height:100%` — no size-to-content; fire-forget so no hang) | N/A (v1 stub) |
| 4 | `NAVIGATE` | fire-forget | — | **N/A** (model slot is an embedded panel; host-navigation out of remit) | ✅ | N/A (v1 stub) |
| 5 | `TRACK_EVENT` | fire-forget | — | **N/A** (analytics; no host-side sink wired in EITHER host today — dropped, never hangs) | **N/A** (same) | N/A (v1 stub) |
| 6 | `REQUEST_SIGN_IN` | fire-forget | — | ✅ | ✅ | N/A (v1 stub) |
| 7 | `REQUEST_CONSENT` | fire-forget | — | ✅ | ✅ | N/A (v1 stub) |
| 8 | `REQUEST_TOKEN` | **REQUEST** | `TOKEN_REFRESH_RESPONSE` | ✅ | ✅ | N/A (v1 stub) |
| 9 | `SUBMIT_WORKFLOW` | **REQUEST** | `WORKFLOW_SUBMITTED` | ✅ | ✅ | N/A (v1 stub) |
| 10 | `ESTIMATE_WORKFLOW` | **REQUEST** | `ESTIMATE_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 11 | `POLL_WORKFLOW` | **REQUEST** | `WORKFLOW_STATUS` | ✅ | ✅ | N/A (v1 stub) |
| 12 | `CANCEL_WORKFLOW` | **REQUEST** | `WORKFLOW_CANCELED` | ✅ | ✅ | N/A (v1 stub) |
| 13 | `OPEN_BUZZ_PURCHASE` | **REQUEST** | `BUZZ_PURCHASE_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 14 | `OPEN_CHECKPOINT_PICKER` | **REQUEST** | `CHECKPOINT_PICKER_RESULT` | ✅ | ✅ (ported #2799) | N/A (v1 stub) |
| 15 | `SET_USER_CHECKPOINT` | **REQUEST** | `USER_CHECKPOINT_SET` | ✅ | ❌→**fail-fast NACK (this PR)** — see OPEN DECISION | N/A (v1 stub) |
| 16 | `APP_STORAGE_GET` | **REQUEST** | `APP_STORAGE_GET_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 17 | `APP_STORAGE_SET` | **REQUEST** | `APP_STORAGE_SET_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 18 | `APP_STORAGE_DELETE` | **REQUEST** | `APP_STORAGE_DELETE_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 19 | `APP_STORAGE_LIST` | **REQUEST** | `APP_STORAGE_LIST_RESULT` | ✅ | ✅ | N/A (v1 stub) |
| 20 | `APP_STORAGE_QUOTA` | **REQUEST** | `APP_STORAGE_QUOTA_RESULT` | ✅ | ✅ | N/A (v1 stub) |

### Verdict summary

- **Before this PR, the ONLY remaining REQUEST-style page gap was `SET_USER_CHECKPOINT`** (#15).
  Every other REQUEST-style message is already handled on the page (workflow set, buzz, storage,
  token, picker). So the "spins forever" exposure on the page surface is down to this one message,
  which this PR closes with a fail-fast NACK.
- `IframeHost` has no REQUEST-style gaps. Its `N/A`s (`NAVIGATE`, `TRACK_EVENT`) are both
  fire-and-forget — never a hang.
- `InlineHost` is a v1 stub (throws on render, no message bridge). EVERY message is N/A for it
  today; the parity guard still enforces a rationale so a future v2 activation can't silently skip
  a required handler.

## What this PR ports vs flags

### Ported: `SET_USER_CHECKPOINT` → fail-fast `USER_CHECKPOINT_SET { ok:false, error }` on the page

`useCheckpointPicker().persist(versionId)` posts `SET_USER_CHECKPOINT` and AWAITS
`USER_CHECKPOINT_SET` (it THROWS the returned `error` string when `ok:false`). Before this PR the
page host had no handler → `persist()` hung to the SDK request timeout.

**Why a NACK and not a real persist:** the server proc `blocks.updateUserSettings`
(`src/server/routers/blocks.router.ts:2572`) HARD-REQUIRES `modelId` in the block-token ctx — it
resolves a model-bound install via `resolveBlockInstance({ modelId, slotId, … })` and throws
`BAD_REQUEST: block token lacks modelId context` otherwise. A **page token's ctx is
`{ slotId, entityType:'none' }` with NO modelId** (`isPageToken`, `blocks.router.ts:226`). A page is
stateless and binds to no model, so there is **no `block_user_settings` row to persist a checkpoint
override into**. Inventing one would be a guess.

The reply TYPE and SHAPE the SDK awaits IS unambiguous (`USER_CHECKPOINT_SET { requestId, ok, error? }`),
so the host can — and now does — reply with an explicit NACK: `ok:false` + a human-readable error.
`persist()` therefore REJECTS FAST with a clear message instead of hanging silently. This is the
task's prescribed behavior for the ambiguous case: fail fast with a KNOWN reply shape, never
fabricate one.

The page's actual checkpoint flow is the in-memory `OPEN_CHECKPOINT_PICKER` result (the block holds
the picked version in its own state) — it does not need a persisted override to function.

## OPEN DECISIONS for a human

1. **Should page blocks be able to PERSIST a viewer checkpoint preference at all?**
   Today: no — there is no page-scoped user-settings target, and `updateUserSettings` demands a
   `modelId` a page token lacks. This PR ships a fail-fast NACK (the safe, non-guessing default).
   IF persistence is wanted, it needs a NEW page-scoped storage target — most naturally the
   App-Storage KV the page token already authorises (`apps:storage:*`), OR a new server proc that
   keys user settings by `(appBlockId, userId)` without a `modelId` — plus a matching read-back
   path so `OPEN_CHECKPOINT_PICKER`/init can surface the persisted value. Out of scope here; this is
   a product decision (do pages even want a sticky per-viewer checkpoint?), not a bug fix.

2. **`TRACK_EVENT` is bridged by NEITHER host.** It's fire-and-forget analytics with no host-side
   sink wired anywhere today, so it's silently dropped (never a hang). If analytics from blocks is
   desired, wire a sink in the relevant host(s) and flip the `TRACK_EVENT` rows to `required` in the
   parity test. Flagged, not fixed — adding a telemetry sink is a feature, not a parity gap.

## The durable guard

`src/components/AppBlocks/hostHandlerParity.test.ts` (plain unit test, `unit` project, node env —
NOT under `src/pages/**`) encodes this whole inventory:

- a hard-coded `INVENTORY` of every block→host message with, per host, `'required'` or an explicit
  `N/A: <one-line rationale>`;
- it greps each host SOURCE for an `onMessage('<TYPE>'` registration (multi-line + inline-generic
  aware) and FAILS if a `required` handler is missing;
- a `SDK_BLOCK_TO_PARENT_TYPES` pin asserts the inventory covers EXACTLY the SDK union — so adding a
  new SDK message without triaging its host coverage fails CI;
- a focused invariant asserts every REQUEST-style message is either handled by `PageBlockHost` or
  carries a documented N/A rationale (the page is the surface most prone to drift).

This converts the whole "spins forever" class into a build-time error the next time someone adds an
SDK message or a new host surface without wiring the host.

## How verified

- Coverage read from the three host sources (handlers are multi-line; greps were cross-checked by
  reading the files, not trusting one-line greps).
- REQUEST vs fire-and-forget confirmed per hook in `civitai-app-starters/packages/civitai-blocks-react/src/hooks/*`.
- The `SET_USER_CHECKPOINT` page-inapplicability confirmed by reading `blocks.updateUserSettings`
  (`modelId` hard-requirement) and `isPageToken` (page ctx has no `modelId`).
- New behavior covered by `PageBlockHostSetUserCheckpoint.browser.test.tsx` (real PageBlockHost,
  real postMessage bridge) + the parity unit test.
- Local `tsc`/full typecheck is broken on this NixOS host (stale Prisma engine); the authoritative
  typecheck is civitai's Tekton pr-preview on the PR.
