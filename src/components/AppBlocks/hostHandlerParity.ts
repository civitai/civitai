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
 * currently-PUBLISHED SDK dist union (forward-looking coverage for a message
 * that exists in the newer `civitai-app-starters` source but not yet in the
 * published `@civitai/app-sdk` dist `BlockToParentMessage`). The compile-time
 * gate below is intentionally ONE-DIRECTIONAL: every PUBLISHED SDK type must be
 * an INVENTORY key, but INVENTORY may carry extra ahead-of-published keys.
 *
 * As of the installed `@civitai/app-sdk@0.65.1` SEVEN keys are ahead: `RUN_CONFIRMED_STEP`,
 * `OPEN_IMAGE_PICKER`, `SET_ENTITY_REACTION`, `GET_ENTITY_REACTIONS`, `OPEN_MEDIA_UPLOAD`,
 * `GET_RESOURCE_FILE` and `VIEWER_ACTIVITY` (sent by `@civitai/sdk`, which this package does not
 * describe). The
 * published union's 50 types are all inventory keys.
 * The gate reads the INSTALLED
 * dist, so it is only as current as the `@civitai/app-sdk` range in
 * `package.json` — a caret on a 0.x version admits patch releases only, and
 * every SDK minor needs an explicit bump before the gate can see its messages.
 *
 * Keep one-line rationales human-readable — they ARE the documentation a future
 * maintainer reads when the parity test fails.
 *
 * The per-host column is also read at RUNTIME: when a host has no handler for a
 * type, `unhandledOutcomeFor` (`bridgeTelemetry.ts`) reports
 * `outcome="not_applicable"` where the column holds a rationale string and
 * `outcome="no_handler"` where it holds `'required'` (or the type is absent). So
 * flipping an entry between the two moves its unhandled traffic between those
 * series on `civitai_app_block_bridge_messages_total`.
 */
export type HostReq = 'required' | string; // string = N/A reason

export interface MessageSpec {
  /** REQUEST-style (sendTypedRequest, awaits a *_RESULT/ack). Unhandled ⇒ hang. */
  request: boolean;
  /**
   * Reply type the SDK awaits (REQUEST-style only); '' for fire-and-forget.
   *
   * 🔴 ENFORCED ONLY FOR THE FORWARDED TYPES. The parity test greps each host for a
   * REGISTERED handler (`onMessage('<TYPE>'`) and merely interpolates this value
   * into the test's NAME, so for every other type a wrong value here is invisible.
   * For the forwarded types (workflows, app subqueue, buzz, viewer, images, private
   * and shared storage), the premise test of the forward matrix
   * (`PageBlockHostForwardMatrix.browser.test.tsx` /
   * `IframeHostForwardMatrix.browser.test.tsx`) asserts this string equals the reply
   * type the hosts are observed to send. For the rest, treat it as a comment and put
   * behavioural claims about the reply in the per-message browser tests.
   */
  reply: string;
  /**
   * Top-level keys of a SUCCESS reply payload, `requestId` left out. A `?` suffix marks a key
   * the reply may omit: a picker's `selected` is absent when the viewer cancels. `null` for
   * fire-and-forget types, which get no reply.
   *
   * A reply counts as an ERROR reply when it has a top-level `error` key; every other reply is
   * checked against this list. It describes the host's wire shape, not what any client
   * expects: `VIEWER_RESULT` stays `{ viewer }`.
   *
   * Checked by `checkReplyKeys` (below):
   *   - the forwarded types (`REPLY_TYPE` in `test/bridgeForwardMatrix.ts`): the premise test
   *     of each forward matrix checks every pinned reply row against this list, and requires
   *     every listed key to appear in some row. `hostHandlerParity.test.ts` runs the same check
   *     over the same rows, so it also runs in the unit tier;
   *   - every other REQUEST type: the per-message tests call `expectReplyKeys` (in
   *     `test/expectReplyKeys.ts`) on a reply the real host sent. `hostHandlerParity.test.ts`
   *     requires a pin from each host that must handle the type, and requires the pinned key
   *     sets to cover every declared key, here and in `errorKeys`.
   *
   * Machine-read: tooling outside this repo may read these lists from the source text with a
   * regex. Keep each one a single-line literal of quoted names, where a reader must accept the
   * `?` suffix. `hostHandlerParity.test.ts` checks the single-line shape.
   */
  replyKeys: readonly string[] | null;
  /**
   * Top-level keys of an ERROR reply (a reply with a top-level `error` string), `requestId` left
   * out. It uses the same `?` notation and always lists `error`. A host-specific error variant
   * can add fields, such as storage's `value: null` or a shared write's `rateLimit`. The fields
   * it adds are marked `?`, because the shared dispatcher's NACK (`buildBridgeNackReply`) is a
   * bare `{ requestId, error }`.
   *
   * `'none'` means the host never sends a top-level `error` for this type. That covers two
   * cases. The workflow family reports failure INSIDE the success shape: a `snapshot` whose
   * `status` is `'failed'`, see `failureSnapshot`. REQUEST_TOKEN has no failure reply at all
   * (`BRIDGE_NACK_EXEMPT`). `null` for fire-and-forget types.
   */
  errorKeys: readonly string[] | 'none' | null;
  IframeHost: HostReq;
  PageBlockHost: HostReq;
  InlineHost: HostReq;
}

// InlineHost is a v1 STUB that throws on render and wires NO message bridge
// (BlockHost never routes inline installs in v1 — `canUseInline` is always
// false). So EVERY message is N/A for it today; the shared reason is below.
export const INLINE_STUB = 'InlineHost is a v1 stub (throws on render, no message bridge in v1)';

export const INVENTORY = {
  // ── Lifecycle / fire-and-forget (no reply ⇒ unhandled never HANGS, but a
  //    page that ignores them just no-ops; documented per host) ───────────────
  //
  // The block's readiness ANNOUNCE — posted by the SDK transport the moment its
  // message listener is attached, so the host can push BLOCK_INIT in response
  // instead of waiting out a retry tick. Fire-and-forget and, uniquely in this
  // table, an ACCELERATOR rather than a bridge: an unhandled BLOCK_HELLO costs
  // only latency, because every host keeps its own immediate-post + bounded
  // retry + readiness-timeout schedule. Marked `required` on the two live hosts
  // anyway — the whole point of the parity gate is that a message the SDK sends
  // has a named answer on every host that could receive it.
  BLOCK_HELLO: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  BLOCK_READY: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  BLOCK_ERROR: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // 🔴 N/A FOR EVERY HOST ON PURPOSE, AND IT IS THE ONLY ENTRY WHOSE `N/A` DOES
  // NOT MEAN "UNHANDLED". `usePostMessage` consumes it in the SHARED DISPATCHER,
  // above the subscriber lookup, because the message is TELEMETRY about the bridge
  // rather than a feature either host implements: it carries no `requestId`, awaits
  // no reply, and reaches no `onMessage` subscriber by design. Registering it
  // per-host would be the same predicate written twice, which is how one of the two
  // copies ends up wrong.
  //
  // The parity test greps each host for `onMessage('<TYPE>'`, so marking it
  // `'required'` would demand a handler that must not exist. Fire-and-forget, so an
  // ignored one can never hang the block — on an OLD host (this entry absent) the
  // dispatcher records one `no_handler` against `'other'` and sends no NACK, since
  // there is no `requestId` for `buildBridgeNackReply` to answer.
  BLOCK_MESSAGE_REJECTED: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost:
      'bridge telemetry, not a feature: consumed by the shared usePostMessage dispatcher above the subscriber lookup, so no per-host onMessage handler exists',
    PageBlockHost:
      'bridge telemetry, not a feature: consumed by the shared usePostMessage dispatcher above the subscriber lookup, so no per-host onMessage handler exists',
    InlineHost: INLINE_STUB,
  },
  RESIZE_IFRAME: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
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
    replyKeys: null,
    errorKeys: null,
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
    replyKeys: null,
    errorKeys: null,
    // Forwarded to /api/track/block-event by `blockEventBeacon.ts`; identity comes from
    // host props, never the payload.
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // `@civitai/sdk`'s throttled report (at most one a minute, no payload) that the viewer pressed,
  // typed, scrolled or focused inside the frame, which the page cannot see. No host handles it: the
  // App Assistant's preview pane reads it straight off the window (`previewKeepAlive.ts`), and
  // fire-and-forget means an unhandled one is dropped with no NACK and nothing waiting on it.
  VIEWER_ACTIVITY: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost:
      'activity report for the App Assistant preview keep-alive, read off the window there; fire-and-forget, nothing to do on a model slot',
    PageBlockHost:
      'activity report read off the window by the App Assistant preview keep-alive (previewKeepAlive.ts), not by the host; fire-and-forget, no reply',
    InlineHost: INLINE_STUB,
  },
  REQUEST_SIGN_IN: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Still `request: false` — the SDK's `useRequestConsent()` posts it with
  // `sendMessage` and AWAITS nothing, so an unhandled one can never hang a block.
  // But BOTH real hosts emit ONE uncorrelated host→block PUSH off this message:
  // when the requested scopes are proven un-grantable (clamped/withheld at mint, so
  // no consent round-trip can ever resolve them) they send
  // `CONSENT_UNAVAILABLE { reason, scopes }` so the block can stop telling the
  // user to retry. It is a push, not a reply — there is no `requestId` to
  // correlate — hence `reply` stays `''`. Behavioural pins:
  // PageBlockHost.browser.test.tsx and IframeHostConsentNotice.browser.test.tsx.
  //
  // 🔴 IT WAS PageBlockHost ONLY, AND THAT WAS THE SHARPER HALF OF A TWO-PART GAP.
  // `grep -c CONSENT_UNAVAILABLE IframeHost.tsx` read 0, so on the model-slot
  // surface a block that DID ask got nothing back over the bridge — the SDK's
  // `requestGrants` promise could resolve `true` or hang, but had no route to
  // `false`. Both hosts now read the same predicate
  // (`resolveUngrantableConsentNotice`, in `requestConsentGate`) and send the same
  // payload shape. ⚠️ `CONSENT_UNAVAILABLE` is absent from the starters repo's
  // `check:parity` snapshot entirely — a companion change is needed THERE; it is
  // not made in this repo.
  REQUEST_CONSENT: {
    request: false,
    reply: '',
    replyKeys: null,
    errorKeys: null,
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },

  // ── REQUEST-style (await a reply ⇒ unhandled HANGS the block) ───────────────
  // 🔴 CONDITIONAL REPLY — the one entry in this table where `reply` is not a
  // single type. A REQUEST_TOKEN carrying a STRING `requestId` (`''` included) is
  // answered with `TOKEN_REFRESH_RESPONSE` echoing that id; one with no usable
  // `requestId` gets a `TOKEN_REFRESH` PUSH instead, because the SDK correlates
  // strictly by `requestId` and an uncorrelated response can never resolve
  // anyone's `refresh()`. `reply` is documentation only (see MessageSpec), so
  // this comment — not that string — is what carries the contract. The
  // behavioural pins are IframeHostInitContractV2 / PageBlockHostInitContractV2
  // `.browser.test.tsx`.
  REQUEST_TOKEN: {
    request: true,
    reply: 'TOKEN_REFRESH_RESPONSE (or a TOKEN_REFRESH push when no requestId was sent)',
    replyKeys: ['token'],
    errorKeys: 'none',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SUBMIT_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_SUBMITTED',
    replyKeys: ['snapshot'],
    errorKeys: 'none',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  ESTIMATE_WORKFLOW: {
    request: true,
    reply: 'ESTIMATE_RESULT',
    replyKeys: ['snapshot'],
    errorKeys: 'none',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // The batch twin of ESTIMATE_WORKFLOW: a list of bodies in, one snapshot per
  // body plus a run total out. Estimate only — nothing is submitted. Both live
  // hosts forward it to `blocks.estimateWorkflowBatch` (decision + reply live in
  // `estimateBatchGate.ts`). Its reply is in the `{ requestId, error }` family, so
  // a host with no handler NACKs it through the shared dispatcher. REQUEST-style.
  ESTIMATE_WORKFLOW_BATCH: {
    request: true,
    reply: 'ESTIMATE_BATCH_RESULT',
    replyKeys: ['snapshots', 'aggregate'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  POLL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_STATUS',
    replyKeys: ['snapshot'],
    errorKeys: 'none',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  CANCEL_WORKFLOW: {
    request: true,
    reply: 'WORKFLOW_CANCELED',
    replyKeys: ['snapshot'],
    errorKeys: 'none',
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_BUZZ_PURCHASE: {
    request: true,
    reply: 'BUZZ_PURCHASE_RESULT',
    replyKeys: ['purchased'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // App generator SUBQUEUE bridges (tag-scoped) — the calling app's OWN slice of
  // the viewer's generation queue: read (image results) + cancel one, both scoped
  // to `app-block:<appId>` server-side (host-forced tag on read; fail-closed
  // ownership+tag guard on cancel — the block never sees the user's personal
  // gens). PAGE-ONLY affordance today (a full-page generator app;
  // model-slot apps are deferred + will get the page host too), so N/A for the
  // model host — mirrors the buzz self-read / OPEN_RESOURCE_PICKER placement.
  QUERY_APP_WORKFLOWS: {
    request: true,
    reply: 'APP_WORKFLOWS_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'app subqueue is a page-only affordance today; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  CANCEL_APP_WORKFLOW: {
    request: true,
    reply: 'CANCEL_APP_WORKFLOW_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'app subqueue is a page-only affordance today; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Model-Benchmarking shared grid — publish the app's OWN workflow outputs as
  // bare, real-scanned public images (host-chrome consent confirm BEFORE the
  // FAIL-CLOSED `blocks.publishGenerationOutputs` MUTATION). Page-only affordance
  // today. Unhandled ⇒ the block hangs; PageBlockHost registers the handler.
  PUBLISH_GENERATION_OUTPUTS: {
    request: true,
    reply: 'PUBLISH_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost:
      'shared-grid publish is a page-only affordance today; the model slot has no such surface',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Model-Benchmarking shared grid — per-viewer gated read of the grid's image
  // ids (the server applies the viewer's browsing-level clamp; above-ceiling /
  // unscanned / flagged come back `hidden` with no url). Host-mediated via the
  // `blocks.getImagesByIds` MUTATION. Page-only affordance today.
  GET_IMAGES_BY_IDS: {
    request: true,
    reply: 'IMAGES_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost:
      'shared-grid gated read is a page-only affordance today; the model slot has no such surface',
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
    replyKeys: ['balance'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Viewer self-read ("who am I") backing the SDK `useViewer()` hook — host-
  // mediated via the `user:read:self`-gated `blocks.getMyViewer` MUTATION, the
  // TWIN of GET /blocks/me and not its successor — a viewer read is data
  // movement, so the REST route is the DEFAULT surface and both stay (see the
  // "Direction" note under Routes in docs/features/app-blocks.md, and
  // civitai/civitai-app-starters#437).
  // PAGE-ONLY affordance today (a page block reading its viewer; model-
  // slot apps are deferred + will get page-host too), so N/A for the model host
  // — mirrors the buzz self-read dashboard bridges.
  GET_VIEWER: {
    request: true,
    reply: 'VIEWER_RESULT',
    replyKeys: ['viewer'],
    errorKeys: ['error'],
    IframeHost: 'viewer self-read is a page-only affordance; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Buzz self-read dashboard bridges (ledger / all-pool balances / per-model
  // earnings) — host-mediated via the `buzz:read:self`-gated `blocks.getMyBuzz*`
  // MUTATIONS.
  // PAGE-ONLY affordance (a Buzz-dashboard page app; model-slot apps are
  // deferred + will get page-host too), so N/A for the model host — mirrors
  // OPEN_RESOURCE_PICKER / OPEN_IMAGE_UPLOAD.
  GET_BUZZ_TRANSACTIONS: {
    request: true,
    reply: 'BUZZ_TRANSACTIONS_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'buzz self-read dashboard is a page-only affordance; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  GET_BUZZ_ACCOUNTS: {
    request: true,
    reply: 'BUZZ_ACCOUNTS_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'buzz self-read dashboard is a page-only affordance; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  GET_DAILY_COMPENSATION: {
    request: true,
    reply: 'DAILY_COMPENSATION_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'buzz self-read dashboard is a page-only affordance; slot-apps deferred',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  OPEN_CHECKPOINT_PICKER: {
    request: true,
    reply: 'CHECKPOINT_PICKER_RESULT',
    replyKeys: ['selected?'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required', // ported in #2799
    InlineHost: INLINE_STUB,
  },
  // The page-surface resource picker (Checkpoint + LoRA allowlist) — the wider
  // generalization of OPEN_CHECKPOINT_PICKER, opened as host chrome so the iframe
  // only ever learns the ONE resource the user picked. IframeHost (model slot)
  // intentionally handles only the narrower OPEN_CHECKPOINT_PICKER — the wider
  // resource picker is a page-only affordance (see the PageBlockHost handler's
  // Design-1 rationale), so it's N/A for the model host.
  OPEN_RESOURCE_PICKER: {
    request: true,
    reply: 'RESOURCE_PICKER_RESULT',
    replyKeys: ['selected?', 'selectedResources?'],
    errorKeys: ['error'],
    IframeHost:
      'model slot uses the narrower OPEN_CHECKPOINT_PICKER; the wider resource picker is a page-only affordance',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // The host-mediated block image-upload bridge (App Blocks Phase-2a PR-C). A block
  // asks the host to let the user upload an image (the app decides what it is for).
  // Host-chrome upload (like OPEN_RESOURCE_PICKER): the page host opens its own
  // upload modal, runs civitai's session-authed upload → REAL scan → server-side
  // SFW + moderation-flag gate, and returns ONLY a moderated image id.
  // A page-only affordance today, so N/A for the model host.
  //
  // NOTE (async cosmetic-image scan): the non-blocking mode's scan VERDICT rides a
  // separate PARENT→BLOCK push, `IMAGE_SCAN_RESOLVED`, which is NOT a
  // BlockToParentMessage and so does NOT belong in this INVENTORY (it tracks only
  // block→host REQUEST types + their replies). OPEN_IMAGE_UPLOAD's TYPE is unchanged
  // — async mode only adds an OPTIONAL `asyncScan` payload field — so no new entry
  // is needed here. Do NOT "add" IMAGE_SCAN_RESOLVED to this map.
  //
  // The `bytes` variant (an app's own image, no picker) is the same type and the same reply, so
  // it needs no entry either. Nor does `purpose: 'trainingData'` (several training images,
  // `selected: { images }`): same type, same reply key.
  OPEN_IMAGE_UPLOAD: {
    request: true,
    reply: 'IMAGE_UPLOAD_RESULT',
    replyKeys: ['selected?'],
    errorKeys: ['error'],
    IframeHost:
      'host-mediated image upload is a page-only affordance today; the model slot has no such surface',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // The viewer picks from their OWN posted / generated images in host chrome (see
  // `imagePickerLogic.ts`); the block receives only the pick. REQUEST-style; ahead of the
  // published SDK dist union (the SDK pair lands in the SDK repo).
  OPEN_IMAGE_PICKER: {
    request: true,
    reply: 'IMAGE_PICKER_RESULT',
    replyKeys: ['selected?', 'selectedImages?'],
    errorKeys: ['error'],
    IframeHost:
      'the image picker is a page-only affordance today; the shared dispatcher NACKs it with an IMAGE_PICKER_RESULT error',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // An image, video or audio file uploaded as a PRIVATE generation input, picked in host chrome or
  // sent as `bytes` — see `mediaUploadLogic.ts`. REQUEST-style; ahead of the published SDK dist
  // union (the SDK pair lands in the SDK repo).
  OPEN_MEDIA_UPLOAD: {
    request: true,
    reply: 'MEDIA_UPLOAD_RESULT',
    replyKeys: ['selected?'],
    errorKeys: ['error'],
    IframeHost:
      'media upload is a page-only affordance today; the shared dispatcher NACKs it with a MEDIA_UPLOAD_RESULT error',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SET_USER_CHECKPOINT: {
    request: true,
    reply: 'USER_CHECKPOINT_SET',
    replyKeys: ['ok'],
    errorKeys: ['error', 'ok?'],
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
    replyKeys: ['value'],
    errorKeys: ['error', 'value?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_SET: {
    request: true,
    reply: 'APP_STORAGE_SET_RESULT',
    replyKeys: ['ok', 'sizeBytes'],
    errorKeys: ['error', 'ok?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_DELETE: {
    request: true,
    reply: 'APP_STORAGE_DELETE_RESULT',
    replyKeys: ['ok', 'deleted'],
    errorKeys: ['error', 'ok?', 'deleted?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_LIST: {
    request: true,
    reply: 'APP_STORAGE_LIST_RESULT',
    replyKeys: ['keys', 'nextCursor'],
    errorKeys: ['error', 'keys?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  APP_STORAGE_QUOTA: {
    request: true,
    reply: 'APP_STORAGE_QUOTA_RESULT',
    replyKeys: ['usedBytes', 'rowCount', 'limitBytes', 'limitRows'],
    errorKeys: ['error', 'usedBytes?', 'rowCount?', 'limitBytes?', 'limitRows?'],
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
  // per-user APP_STORAGE_* placement).
  SHARED_LIST: {
    request: true,
    reply: 'SHARED_LIST_RESULT',
    replyKeys: ['items', 'nextCursor'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_GET_COUNT: {
    request: true,
    reply: 'SHARED_GET_COUNT_RESULT',
    replyKeys: ['count'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_GET_COUNTS: {
    request: true,
    reply: 'SHARED_GET_COUNTS_RESULT',
    replyKeys: ['counts'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_APPEND: {
    request: true,
    reply: 'SHARED_APPEND_RESULT',
    replyKeys: ['key'],
    errorKeys: ['error', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Author-scoped in-place edit of an OWN shared_kv row (the sibling of
  // SHARED_APPEND's INSERT-only write; fixes "editing creates a new one"). Same
  // REQUEST-style hang class + same host placement as SHARED_APPEND — the shared
  // datastore is a per-APP surface a model-slot block can also edit, so BOTH real
  // hosts wire it. Reply is the SHARED_WITHDRAW-style `{ ok, error? }` (NOT
  // SHARED_APPEND's `{ key }`). The SDK's isValidSharedUpdateResult accepts an
  // error reply whether or not it carries `ok` — every `{ ok, error }` validator
  // early-accepts on a PRESENT `error`, so an error reply is never dropped. The
  // hosts still send `ok: false` because it is the clearer signal, NOT because
  // omitting it would hang.
  SHARED_UPDATE: {
    request: true,
    reply: 'SHARED_UPDATE_RESULT',
    replyKeys: ['ok'],
    errorKeys: ['error', 'ok?', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_VOTE: {
    request: true,
    reply: 'SHARED_VOTE_RESULT',
    replyKeys: ['count'],
    errorKeys: ['error', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_UNVOTE: {
    request: true,
    reply: 'SHARED_UNVOTE_RESULT',
    replyKeys: ['count'],
    errorKeys: ['error', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  SHARED_WITHDRAW: {
    request: true,
    reply: 'SHARED_WITHDRAW_RESULT',
    replyKeys: ['ok', 'deleted'],
    errorKeys: ['error', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Single-row fetch-by-key (Batch-D item 6) — the deep-link companion to
  // SHARED_LIST's paged read. Same REQUEST-style hang class + same both-host
  // placement as its SHARED_* siblings (the shared datastore is a per-APP surface
  // a model-slot block can also read).
  SHARED_GET: {
    request: true,
    reply: 'SHARED_GET_RESULT',
    replyKeys: ['item'],
    errorKeys: ['error', 'item?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // User report of a posted shared row (Batch-D item 5) — the server procedure
  // `apps.shared.report` already exists; this is the postMessage seam. Same both-
  // host placement as SHARED_WITHDRAW (its reply is the SHARED_WITHDRAW-style
  // `{ ok, error? }`: the validator accepts an error reply with or without `ok`,
  // and the hosts send `ok: false` because it is the clearer signal, not because
  // omitting it would hang).
  SHARED_REPORT: {
    request: true,
    reply: 'SHARED_REPORT_RESULT',
    replyKeys: ['ok'],
    errorKeys: ['error', 'ok?', 'rateLimit?'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Host download bridge (Batch-D item 1) — the host fetches an image in its
  // UNSANDBOXED top frame + triggers the browser download (a sandboxed block has
  // no `allow-downloads`). Three variants: an origin-allowlisted OWN-output `url`,
  // a cross-user `imageId` routed through the gated per-viewer read, or block-made
  // `bytes` classified by content (image / JSON / text only). PAGE-ONLY
  // affordance today (the paid-output apps — gen-matrix / custom-generators /
  // model-benchmarking — are all page apps), so N/A for the model host, mirroring
  // the GET_IMAGES_BY_IDS / PUBLISH_GENERATION_OUTPUTS page-only exemption.
  SAVE_IMAGE: {
    request: true,
    reply: 'SAVE_IMAGE_RESULT',
    replyKeys: ['ok'],
    errorKeys: ['error', 'ok?'],
    IframeHost:
      'download bridge is a page-only affordance today; the paid-output apps are page apps, the model slot has no such surface',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── Wildcard-pack import (W13, page-host bridge) ───────────────────────────
  // A page block asks the HOST to resolve + fetch + unzip + parse a wildcard
  // pack's list files, as the logged-in user (the host holds the real session).
  // REQUEST-style ⇒ an unhandled one HANGS the block.
  //
  // PAGE-ONLY affordance: the resolve+parse runs against the viewer's real
  // session + browsing-level ceiling and is a full-page import flow. The model
  // slot (IframeHost) has no wildcard-import surface — a model-column panel
  // doesn't import prompt-list packs — so it's N/A there, exactly as the wider
  // OPEN_RESOURCE_PICKER is page-only.
  GET_WILDCARD_PACK: {
    request: true,
    reply: 'WILDCARD_PACK_RESULT',
    replyKeys: ['pack'],
    errorKeys: ['error'],
    IframeHost:
      'model slot has no wildcard-pack import surface; the resolve+parse bridge is a page-only affordance',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Workflow-file read (civitai-app-starters#664): the GET_WILDCARD_PACK pattern
  // for Workflows / ComfyWorkflows versions. Page-only by decision on that issue.
  GET_RESOURCE_FILE: {
    request: true,
    reply: 'RESOURCE_FILE_RESULT',
    replyKeys: ['file'],
    errorKeys: ['error'],
    IframeHost:
      'model slot has no resource-file surface; page-only by decision (civitai-app-starters#664)',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── Collection follow/unfollow (host bridge) ───────────────────────────────
  // A block asks the HOST to follow/unfollow a collection as the logged-in
  // viewer. Replaces the block's own `POST /api/v1/blocks/collections/[id]/follow`
  // call (which stays live — this bridge does NOT retire it), so an app no longer
  // needs the `collections:write:self` write scope for an on-site bookmark.
  //
  // 🔴 THIS IS A TIGHTENING, NOT A LOOSENING. ⚠️ An earlier copy of this comment
  // said the dropped scope "was the viewer's consent step" — RETRACTED, it is
  // false: `collections:write:self` is in `CONSENT_EXEMPT_SCOPES`
  // (`src/server/services/blocks/scope-grant.service.ts`), so it mints without any
  // prompt and no grant row is ever recorded. The HTTP path had ZERO prompts;
  // both hosts now open a HOST-CHROME CONSENT CONFIRM and write only on the
  // viewer's explicit click — the same boundary PUBLISH_GENERATION_OUTPUTS uses.
  // What the bridge actually gives up is the manifest `scopes` DECLARATION, i.e.
  // ex-ante reviewability (moderator review + the post-install permissions panel),
  // traded for consent at the moment of action. Full reasoning, and why the
  // confirm must not be "restored" into a scope gate, is in
  // `collectionFollowGate.ts`, which both hosts share.
  //
  // BOTH real hosts: unlike the page-only affordances above, a collection follow
  // is a plain on-site bookmark with no page-sized surface behind it — a model-
  // slot block showing a collection has exactly the same reason to offer it.
  // REQUEST-style ⇒ an unhandled one HANGS the block.
  SET_COLLECTION_FOLLOW: {
    request: true,
    reply: 'COLLECTION_FOLLOW_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── App reactions (image only, v1) ─────────────────────────────────────────
  // A block sets or reads the VIEWER'S reaction on an image a block endpoint served it,
  // through `blocks.setReactionFromApp` / `blocks.getReactionsForApp` (block token + session).
  // No per-tap confirm: the consent is the consent-gated `social:react:self` grant. Shared
  // decision layer: `reactionGate.ts`. BOTH real hosts, like SET_COLLECTION_FOLLOW: a model-slot
  // block showing images has the same reason to offer a ♥ as a page block. Ahead of the
  // published SDK dist union (the SDK pair ships after this deploys). REQUEST-style.
  SET_ENTITY_REACTION: {
    request: true,
    reply: 'ENTITY_REACTION_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  GET_ENTITY_REACTIONS: {
    request: true,
    reply: 'ENTITY_REACTIONS_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    IframeHost: 'required',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // ── Create a REAL Post from the app's own outputs (two-phase) ──────────────
  // The strictly-more-consequential SIBLING of PUBLISH_GENERATION_OUTPUTS: that
  // one makes a bare Image row (no post, no feed, no reward, no notification);
  // this one makes PUBLIC, feed-visible, reward-earning content under the
  // VIEWER'S byline, optionally attached to a model version's gallery.
  //
  // 🔴 IT IS A SIBLING, NOT A FLAG ON THAT MESSAGE, FOR TWO DECISIVE REASONS.
  // (1) SHAPE: `PUBLISH_GENERATION_OUTPUTS.payload.workflowId` is a SINGLE
  // REQUIRED STRING and cannot express a post built from several workflows plus
  // previously-published images. (2) COPY: the publish confirm says the images
  // "become visible to other viewers of this app", which is FALSE for a profile
  // post — and that sentence is the security control, not decoration. One handler
  // branching on payload shape means one of the two dialogs is always wrong.
  //
  // THE HANDLER IS TWO SERVER CALLS, NOT ONE. `blocks.previewPostFromApp`
  // resolves the consent payload server-side (exact copy, the tag names that will
  // ACTUALLY apply, host-fetched model/version names, real thumbnails), the
  // viewer confirms, and only then does `blocks.createPostFromApp` write. The
  // preview exists because the block is sandboxed: a confirm rendering
  // block-supplied text or thumbnails could show one thing and publish another.
  // The preview confers NOTHING — the write re-runs every guard.
  //
  // REQUEST-style ⇒ an unhandled one HANGS the block to its 10-minute human
  // timeout.
  CREATE_POST_FROM_APP: {
    request: true,
    reply: 'CREATE_POST_RESULT',
    replyKeys: ['result'],
    errorKeys: ['error'],
    // N/A, and for the SAME structural reason as PUBLISH_GENERATION_OUTPUTS /
    // QUERY_APP_WORKFLOWS / CANCEL_APP_WORKFLOW above — not a smaller version of
    // the same reason. Every image this message can post comes from the app
    // SUBQUEUE (the app's own workflows) or from what the app previously
    // published THROUGH that subqueue, and the subqueue is a page-only
    // affordance: the model slot has no composition surface, so a model-slot
    // block has no eligible images to post in the first place. Registering a
    // handler here would add a consent dialog over an empty source set. If a slot
    // app ever gains a subqueue, this entry becomes `required` in the same change.
    IframeHost:
      'every eligible image comes from the app subqueue, which is a page-only affordance; a model-slot block has no source images to post',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Start a confirmed `kind:'training'` run — see `runTrainingGate.ts`. REQUEST-style.
  RUN_TRAINING: {
    request: true,
    reply: 'TRAINING_RESULT',
    replyKeys: ['snapshot'],
    errorKeys: ['error'],
    IframeHost:
      'training is page-only on the server; the shared dispatcher NACKs it with a TRAINING_RESULT error',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // Run ONE confirmed pass-through step whose fixed price exceeds the per-call budget —
  // see `runConfirmedStepGate.ts`. REQUEST-style; ahead of the published SDK dist union
  // (the SDK pair lands in the SDK repo).
  RUN_CONFIRMED_STEP: {
    request: true,
    reply: 'CONFIRMED_STEP_RESULT',
    replyKeys: ['snapshot'],
    errorKeys: ['error'],
    IframeHost:
      'confirmed steps are page-only on the server; the shared dispatcher NACKs it with a CONFIRMED_STEP_RESULT error',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
  // REMOVED: training images are uploaded through OPEN_IMAGE_UPLOAD { purpose:
  // 'trainingData' }. The page host still answers it, with the fixed error `removed`,
  // so an older bundle fails at once instead of hanging. REQUEST-style.
  PREPARE_TRAINING_DATASET: {
    request: true,
    reply: 'TRAINING_DATASET_RESULT',
    replyKeys: [],
    errorKeys: ['error'],
    IframeHost:
      'training is page-only on the server; the shared dispatcher NACKs it with a TRAINING_DATASET_RESULT error',
    PageBlockHost: 'required',
    InlineHost: INLINE_STUB,
  },
} satisfies Record<string, MessageSpec>;

export type InventoryType = keyof typeof INVENTORY;

/** What `checkReplyKeys` concluded about one reply payload. */
export interface ReplyKeysCheck {
  /** `'error'` when the payload has a top-level `error` key, otherwise `'success'`. */
  outcome: 'success' | 'error';
  /** Each way the payload disagrees with the declared keys. Empty when it agrees. */
  problems: string[];
}

/** Split a declared key list into the keys a reply must carry and the keys it may carry. */
export function parseDeclaredKeys(declared: readonly string[]): {
  required: string[];
  optional: string[];
} {
  const required: string[] = [];
  const optional: string[] = [];
  for (const key of declared) {
    if (key.endsWith('?')) optional.push(key.slice(0, -1));
    else required.push(key);
  }
  return { required, optional };
}

/**
 * Compare one reply payload a host sent for `type` with what INVENTORY declares for it
 * (`replyKeys` / `errorKeys`). It checks the top-level key set only, never the value types.
 */
export function checkReplyKeys(type: InventoryType, payload: unknown): ReplyKeysCheck {
  const spec: MessageSpec = INVENTORY[type];
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { outcome: 'success', problems: [`${type}: reply payload is not an object`] };
  }
  const keys = Object.keys(payload).filter((k) => k !== 'requestId');
  const outcome = Object.prototype.hasOwnProperty.call(payload, 'error') ? 'error' : 'success';
  const declared = outcome === 'error' ? spec.errorKeys : spec.replyKeys;
  const field = outcome === 'error' ? 'errorKeys' : 'replyKeys';
  if (declared === null) {
    return { outcome, problems: [`${type}: fire-and-forget, so it declares no reply`] };
  }
  if (declared === 'none') {
    return {
      outcome,
      problems: [`${type}: the reply has a top-level \`error\`, but errorKeys is 'none'`],
    };
  }
  const { required, optional } = parseDeclaredKeys(declared);
  const problems: string[] = [];
  for (const k of required) {
    if (!keys.includes(k)) problems.push(`${type}: ${field} requires \`${k}\`; the reply lacks it`);
  }
  for (const k of keys) {
    if (!required.includes(k) && !optional.includes(k)) {
      problems.push(`${type}: the reply carries \`${k}\`, which ${field} does not declare`);
    }
  }
  return { outcome, problems };
}

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
// INVENTORY MAY carry extra ahead-of-published keys (`RUN_CONFIRMED_STEP`,
// `OPEN_IMAGE_PICKER`, `SET_ENTITY_REACTION`, `GET_ENTITY_REACTIONS`, `OPEN_MEDIA_UPLOAD`,
// `GET_RESOURCE_FILE`, `VIEWER_ACTIVITY` as of app-sdk 0.65.1).
// We do NOT assert the reverse — that would delete real forward coverage every
// time the published dist lags.
//
// "PUBLISHED" here means the INSTALLED dist, i.e. whatever the `@civitai/app-sdk`
// range in `package.json` resolves to. While that range trails npm, a message
// the SDK has already shipped is invisible to this gate.
//
// If this errors, the failure type prints the missing type(s):
//   ['INVENTORY missing published SDK message(s):', <the missing union members>]
// ─────────────────────────────────────────────────────────────────────────────
type _SdkCovered = SdkBlockToParentType extends keyof typeof INVENTORY
  ? true
  : [
      'INVENTORY missing published SDK message(s):',
      Exclude<SdkBlockToParentType, keyof typeof INVENTORY>
    ];
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _sdkCovered: _SdkCovered = true;
