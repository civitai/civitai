import type { BlockToParentMessageType } from '@civitai/app-sdk/blocks';

/**
 * App Blocks host↔SDK handler PARITY inventory + the COMPILE-TIME coverage gate.
 *
 * This is the NON-TEST module (NOT `*.test.ts`) so the type-level assertion at
 * the bottom is guaranteed to be in civitai's `tsc --noEmit` / `next build`
 * typecheck graph regardless of how the test runner treats `*.test.ts` files.
 * (It is NOT under `src/pages/**` — Next would treat those as routes; gotchas
 * #78/#81.) The runtime grep-based parity assertions live in
 * `hostHandlerParity.test.ts`, which imports `INVENTORY` from here.
 *
 * THE BUG CLASS this encodes (gotcha-#73, the "spins forever, no network call,
 * no console error" class):
 *
 *   App Blocks has multiple host components that each register their own
 *   `onMessage('<TYPE>', …)` handlers BY HAND to bridge a block's postMessages:
 *     - IframeHost.tsx     — model-slot host (model.sidebar slots)
 *     - PageBlockHost.tsx  — full-page run host (civitai.com/apps/run/<slug>)
 *     - InlineHost.tsx     — inline host (v2 stub, not active in prod)
 *
 *   The SDK (`@civitai/app-sdk` / `@civitai/blocks-react`) sends two flavours of
 *   block→host message: REQUEST-style (`sendTypedRequest`, AWAITS a specific
 *   `*_RESULT` / ack reply) and fire-and-forget (`sendMessage`, no reply). When
 *   a block sends a REQUEST-style message and the host has NO handler, the
 *   request never gets a reply → the block hangs to its SDK request timeout →
 *   the UI spins forever with no network call and no error. The dev:live SDK
 *   host serves these messages, so authors test green locally then break in
 *   prod — a fidelity gap (this exact gap bit OPEN_CHECKPOINT_PICKER on pages,
 *   fixed in civitai #2799).
 *
 * SOURCE OF TRUTH for the inventory: the SDK message protocol
 * `@civitai/app-sdk` `blocks/messages.ts` `BlockToParentMessage` union, cross-
 * referenced with the `@civitai/blocks-react` hooks (which `type` each posts and
 * whether it uses `sendTypedRequest` [REQUEST] or `sendMessage` [fire-forget]).
 * When the SDK adds a block→host message, add it here with its hosts/exemptions.
 *
 * Maintenance: the grep-based test is a deliberately DUMB structural check — it
 * asserts a handler is REGISTERED, not that it's correct. Behavioral correctness
 * lives in the per-message browser tests (PageBlockHost*.browser.test.tsx). The
 * value here is catching the MISSING-handler case the next time the protocol
 * grows.
 */

export type HostFile = 'IframeHost.tsx' | 'PageBlockHost.tsx' | 'InlineHost.tsx';

/**
 * The authoritative inventory: every block→host message a host may receive, with
 * per-host requirements. `request: true` = REQUEST-style (awaits a reply; an
 * unhandled one HANGS the block — this is the dangerous class). For each host,
 * `'required'` means the host MUST register a handler; a string is an explicit
 * `N/A` rationale (the host legitimately doesn't handle it).
 *
 * NOTE: `INVENTORY` may legitimately contain entries that are AHEAD of the
 * currently-PUBLISHED SDK dist union (forward-looking coverage — e.g.
 * `CANCEL_WORKFLOW`, `REQUEST_SIGN_IN`, `REQUEST_CONSENT` exist in the newer
 * `civitai-app-starters` source but not yet in the published
 * `@civitai/app-sdk` dist `BlockToParentMessage`). The compile-time gate below
 * is intentionally ONE-DIRECTIONAL: every PUBLISHED SDK type must be an
 * INVENTORY key, but INVENTORY may carry extra ahead-of-published keys.
 *
 * Keep one-line rationales human-readable — they ARE the documentation a future
 * maintainer reads when the parity test fails.
 */
export type HostReq = 'required' | string; // string = N/A reason

export interface MessageSpec {
  /** REQUEST-style (sendTypedRequest, awaits a *_RESULT/ack). Unhandled ⇒ hang. */
  request: boolean;
  /** Reply type the SDK awaits (REQUEST-style only); '' for fire-and-forget. */
  reply: string;
  IframeHost: HostReq;
  PageBlockHost: HostReq;
  InlineHost: HostReq;
}

// InlineHost is a v1 STUB that throws on render and wires NO message bridge
// (BlockHost never routes inline installs in v1 — `canUseInline` is always
// false). So EVERY message is N/A for it today; the shared reason is below.
export const INLINE_STUB =
  'InlineHost is a v1 stub (throws on render, no message bridge in v1)';

export const INVENTORY = {
  // ── Lifecycle / fire-and-forget (no reply ⇒ unhandled never HANGS, but a
  //    page that ignores them just no-ops; documented per host) ───────────────
  BLOCK_READY: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  BLOCK_ERROR: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  RESIZE_IFRAME: {
    request: false,
    reply: '',
    IframeHost: 'required',
    // N/A: the page renders the iframe full-viewport (height:100%); a page block
    // fills the surface and does NOT size-to-content, so there is nothing to
    // resize. Fire-and-forget ⇒ an ignored RESIZE_IFRAME never hangs the block.
    PageBlockHost:
      'page iframe is full-viewport (height:100%); no size-to-content, fire-and-forget so no hang',
    InlineHost: INLINE_STUB,
  },
  NAVIGATE: {
    request: false,
    reply: '',
    // N/A: the model slot is an embedded panel inside the model page — a block
    // navigating the host away from the model page is out of its remit; the
    // model host intentionally does not bridge NAVIGATE.
    IframeHost:
      'model slot is an embedded panel; host-navigation is out of remit (no NAVIGATE bridge)',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  TRACK_EVENT: {
    request: false,
    reply: '',
    // N/A (both real hosts): TRACK_EVENT is fire-and-forget analytics and is
    // currently NOT bridged by EITHER host (no host-side analytics sink wired).
    // Unhandled ⇒ silently dropped, never a hang. If a sink is added, flip the
    // relevant host(s) to 'required' here so coverage is enforced.
    IframeHost: 'analytics fire-and-forget; no host-side sink wired (dropped, never hangs)',
    PageBlockHost: 'analytics fire-and-forget; no host-side sink wired (dropped, never hangs)',
    InlineHost: INLINE_STUB,
  },
  // REQUEST_SIGN_IN / REQUEST_CONSENT are AHEAD of the published SDK dist union
  // (present in the newer civitai-app-starters source). Forward-looking coverage
  // — kept intentionally; the compile-time gate does not require published.
  REQUEST_SIGN_IN: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  REQUEST_CONSENT: {
    request: false,
    reply: '',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },

  // ── REQUEST-style (await a reply ⇒ unhandled HANGS the block) ───────────────
  REQUEST_TOKEN: {
    request: true,
    reply: 'TOKEN_REFRESH_RESPONSE',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SUBMIT_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_SUBMITTED',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  ESTIMATE_WORKFLOW: {
    request: true,
    reply: 'ESTIMATE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  POLL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_STATUS',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // CANCEL_WORKFLOW is AHEAD of the published SDK dist union (present in the
  // newer civitai-app-starters source). Forward-looking coverage — kept.
  CANCEL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_CANCELED',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_BUZZ_PURCHASE: {
    request: true,
    reply: 'BUZZ_PURCHASE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Per-account (blue/green/yellow) balance read backing the SDK
  // `useBuzzBalance()` hook + the account-picker (Phase 3 host wiring). Host-
  // mediated via the block-token-authed `blocks.getMyBuzzBalance` MUTATION.
  // Unhandled ⇒ the block hangs; both real hosts register a handler.
  GET_BUZZ_BALANCE: {
    request: true,
    reply: 'BUZZ_BALANCE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_CHECKPOINT_PICKER: {
    request: true,
    reply: 'CHECKPOINT_PICKER_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required', // ported in #2799
    InlineHost: INLINE_STUB,
  },
  // The page-surface resource picker (Checkpoint + LoRA allowlist) — the wider
  // generalization of OPEN_CHECKPOINT_PICKER, opened as host chrome so the iframe
  // only ever learns the ONE resource the user picked. Now PUBLISHED in the SDK
  // dist union (was ahead-of-published under app-sdk 0.6), so the compile-time
  // gate requires it here. IframeHost (model slot) intentionally handles only the
  // narrower OPEN_CHECKPOINT_PICKER — the wider resource picker is a page-only
  // affordance (see the PageBlockHost handler's Design-1 rationale), so it's N/A
  // for the model host.
  OPEN_RESOURCE_PICKER: {
    request: true,
    reply: 'RESOURCE_PICKER_RESULT',
    IframeHost:
      'model slot uses the narrower OPEN_CHECKPOINT_PICKER; the wider resource picker is a page-only affordance',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SET_USER_CHECKPOINT: {
    request: true,
    reply: 'USER_CHECKPOINT_SET',
    IframeHost: 'required',
    // PAGE: persists to block_user_settings keyed by a model-bound install;
    // updateUserSettings HARD-REQUIRES modelId in the token ctx, which a page
    // token (entityType:'none') lacks. The page host registers a FAIL-FAST NACK
    // (USER_CHECKPOINT_SET ok:false) so persist() rejects immediately instead of
    // hanging — see the handler comment + the parity doc's OPEN DECISION.
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_GET: {
    request: true,
    reply: 'APP_STORAGE_GET_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_SET: {
    request: true,
    reply: 'APP_STORAGE_SET_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_DELETE: {
    request: true,
    reply: 'APP_STORAGE_DELETE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_LIST: {
    request: true,
    reply: 'APP_STORAGE_LIST_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_QUOTA: {
    request: true,
    reply: 'APP_STORAGE_QUOTA_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── SHARED (cross-user / app-global) storage (Phase 2b) ────────────────────
  // The public-write sibling of the per-user APP_STORAGE_* bridge. REQUEST-style
  // (each awaits its SHARED_*_RESULT ⇒ unhandled HANGS the block). The shared
  // voting/requests app is a PAGE app (entity=none) so PageBlockHost is the
  // primary target, but the shared datastore is a per-APP surface an app's
  // model-slot block could also read, so BOTH real hosts wire it (matching the
  // per-user APP_STORAGE_* placement). Ahead of the published SDK dist union
  // (forward-looking coverage, like APP_STORAGE_* were) — the compile-time gate
  // is one-directional so extra keys here are fine.
  SHARED_LIST: {
    request: true,
    reply: 'SHARED_LIST_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_GET_COUNT: {
    request: true,
    reply: 'SHARED_GET_COUNT_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_GET_COUNTS: {
    request: true,
    reply: 'SHARED_GET_COUNTS_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_APPEND: {
    request: true,
    reply: 'SHARED_APPEND_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_VOTE: {
    request: true,
    reply: 'SHARED_VOTE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_UNVOTE: {
    request: true,
    reply: 'SHARED_UNVOTE_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_WITHDRAW: {
    request: true,
    reply: 'SHARED_WITHDRAW_RESULT',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── Wildcard-pack import (W13, page-host bridge) ───────────────────────────
  // A page block asks the HOST to resolve + fetch + unzip + parse a wildcard
  // pack's list files, as the logged-in user (the host holds the real session).
  // REQUEST-style ⇒ an unhandled one HANGS the block. Ahead of the published SDK
  // dist union (forward-looking coverage, like OPEN_IMAGE_UPLOAD / SHARED_* were)
  // — the compile-time gate is one-directional so an extra key here is fine.
  //
  // PAGE-ONLY affordance: the resolve+parse runs against the viewer's real
  // session + browsing-level ceiling and is a full-page import flow. The model
  // slot (IframeHost) has no wildcard-import surface — a model-column panel
  // doesn't import prompt-list packs — so it's N/A there, exactly as the wider
  // OPEN_RESOURCE_PICKER is page-only.
  GET_WILDCARD_PACK: {
    request: true,
    reply: 'WILDCARD_PACK_RESULT',
    IframeHost:
      'model slot has no wildcard-pack import surface; the resolve+parse bridge is a page-only affordance',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
} satisfies Record<string, MessageSpec>;

/**
 * The PUBLISHED SDK block→host message union, read straight from the installed
 * `@civitai/app-sdk/blocks` package (NOT a hand-maintained literal). This is the
 * real contract civitai builds against.
 */
type SdkBlockToParentType = BlockToParentMessageType;

// ─────────────────────────────────────────────────────────────────────────────
// COMPILE-TIME coverage gate (the one manual step the runtime grep test CANNOT
// catch): if the PUBLISHED SDK adds a block→host message type that INVENTORY
// doesn't list, this becomes a TypeScript ERROR — caught by civitai's Tekton
// typecheck / `next build`, because this module is in the tsconfig `include`
// graph (under `src`, not excluded; not a `*.test.ts` corner case).
//
// ONE-DIRECTIONAL by design: every PUBLISHED SDK type must be an INVENTORY key;
// INVENTORY MAY carry extra ahead-of-published keys (CANCEL_WORKFLOW,
// REQUEST_SIGN_IN, REQUEST_CONSENT today). We do NOT assert the reverse — that
// would delete real forward coverage every time the published dist lags.
//
// If this errors, the failure type prints the missing type(s):
//   ['INVENTORY missing published SDK message(s):', <the missing union members>]
// ─────────────────────────────────────────────────────────────────────────────
type _SdkCovered = SdkBlockToParentType extends keyof typeof INVENTORY
  ? true
  : ['INVENTORY missing published SDK message(s):', Exclude<SdkBlockToParentType, keyof typeof INVENTORY>];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sdkCovered: _SdkCovered = true;
