/**
 * App Blocks BRIDGE telemetry — the label sets and wire bounds, and NOTHING ELSE.
 *
 * 🔴 IT IS A SEPARATE MODULE FROM `bridgeTelemetry.ts` FOR ONE MEASURED REASON:
 * `bridgeTelemetry` imports `hostHandlerParity`'s 47-key `INVENTORY` (several KB
 * minified) to bound the `type` label. `src/server/schema/track.schema.ts` needs
 * the label ENUMS so the beacon's zod schema and the emitter cannot drift — and
 * `track.schema` is imported by `TrackView` on pages that mount no block at all,
 * so importing the INVENTORY-bearing module there would put that payload into
 * bundles that can never use it. Splitting keeps the single-sourcing without that
 * cost — specifically in the `track.schema`/`TrackView` graph. It is NOT a claim
 * that the INVENTORY stays out of the browser generally: a page that mounts a
 * block pulls it in through `usePostMessage` -> `bridgeMessageBeacon` ->
 * `bridgeTelemetry`, which is the price of clamping the `type` label client-side
 * and is paid only where a bridge actually exists.
 *
 * So: nothing in this file may import anything. If a constant here grows a
 * dependency, it belongs next door.
 */

/**
 * The bridge OUTCOME label set — closed, code-owned, and exhaustive over what the
 * dispatcher can do with one inbound message.
 *
 *   handled      — at least one registered handler was invoked. The steady state,
 *                  and the DENOMINATOR: without it an error count is unreadable
 *                  (a falling error count and a falling traffic count look the
 *                  same).
 *   no_handler   — no handler was registered for the type on this host. For a
 *                  REQUEST-style message this is the expensive one: the block
 *                  hangs to its per-class SDK timeout (30s default, 120s
 *                  workflow, 600s human-in-the-loop).
 *   rate_limited — the 30 msg/sec inbound budget was exhausted.
 *   deduped      — the same `requestId` arrived twice inside the 5s dedup window.
 *   no_token     — a handler ran, found no usable block credential, and refused.
 *   validator_rejected
 *                — the BLOCK refused our reply at its own trust boundary and
 *                  dropped it, so its request hangs to the SDK timeout. The only
 *                  outcome here with a confirmed production incident behind it.
 *                  ⚠️ NOT "the fifth and final" silence — the SDK's own
 *                  `handleMessage` still drops silently and uncounted on an origin
 *                  mismatch, on a malformed envelope, and on a well-formed reply
 *                  whose `requestId` matches no pending request. This value covers
 *                  the validator path only.
 *
 * 🔴 `no_token` is reported BY THE HANDLER, not by the dispatcher — the dispatcher
 * has no idea a token exists. It rides the same counter because an operator asking
 * "why did this block stall" needs one series, not two.
 *
 * 🔴 `validator_rejected` IS REPORTED BY THE BLOCK, NOT OBSERVED BY US, AND THAT IS
 * NOT A GAP WE CAN CLOSE. The SDK's `internal/validate.ts` shape-checks every
 * inbound payload IN THE IFRAME, i.e. after this host has already replied — from
 * here the exchange completed and the dispatcher counts it `handled`. So the only
 * party that can see it is the block, which now says so with a fire-and-forget
 * `BLOCK_MESSAGE_REJECTED` (`@civitai/app-sdk/blocks`); `usePostMessage` turns that
 * into this outcome. THREE things to read the series with — and an earlier revision
 * of this line said "two" while carrying three bullets, which is the same
 * headline-outran-its-own-list defect corrected in `BRIDGE_MESSAGE_COUNT_MAX` below,
 * re-made by the commit that corrected it there:
 *  - the `type` on it is the BLOCK→HOST REQUEST left hanging (`GET_IMAGES_BY_IDS`),
 *    not the rejected reply (`IMAGES_RESULT`). Deliberate: `boundBridgeMessageType`
 *    bounds the label against `hostHandlerParity`'s INVENTORY, which holds no
 *    `*_RESULT` key, so a reply type would clamp to `'other'` and collapse every
 *    rejection onto one label;
 *  - it is NOT undercounted, and an earlier revision of this line said it was. A
 *    30-per-10s emit budget was written on the SDK side and removed BEFORE either
 *    half merged — it never reached a published package, so no bundle in the field
 *    carries one and there is no older population that undercounts. (Stated
 *    precisely because "shipped, then deleted" — the previous wording — reads as
 *    release history and would tell an operator the opposite.) A cap there made a
 *    flood read SMALL, the one shape of wrongness this very file rejects a few
 *    paragraphs down. Magnitude here is unbounded exactly as it is for `no_handler`
 *    and `deduped`;
 *  - 🔴 A ZERO IS NOT EVIDENCE OF HEALTH, and this is the caveat that matters. The
 *    emitter lives in each block's OWN bundle (every app pins
 *    `@civitai/blocks-react` itself), so a zero is per-APP and never fleet-wide:
 *    **read it with `app_block_id`**. For a given app, zero means "no rejections"
 *    OR "this app has not shipped a carrying `blocks-react`", and the two are
 *    indistinguishable from the series alone. 🔴 OTHER APPS REPORTING DOES NOT
 *    SETTLE IT — the counter goes non-zero the moment the FIRST rebuilt app hits a
 *    rejection, so "the fleet has picked it up" is exactly the wrong inference to
 *    draw from a non-zero total while another app's slice sits at zero. A flat-zero
 *    diagnostic read as health is the failure this outcome exists to end, and
 *    reading it fleet-wide re-creates it one level up.
 *
 * ⚠️ ADDING THIS SIXTH VALUE GREW THE COUNTER'S WORST-CASE LABEL PRODUCT BY 22.6%,
 * not the 20% an earlier revision of this line claimed: the outcome axis alone is
 * +20%, but `BLOCK_MESSAGE_REJECTED` also added an INVENTORY key, so the type axis
 * moved too. Re-derived at 50 approved apps: (50+1) x 48 x 2 x 6 = 29,376, against
 * 51 x 47 x 2 x 5 = 23,970 before. Both include the `'other'` slot each axis adds —
 * that line's `x 47` omitted it. `/api/track/block-message`'s docblock asks for the
 * product to be read before a label is added; an outcome VALUE is the cheaper axis
 * than a fifth label, which is why this arrived as one. ⚠️ And it is a CEILING, not
 * allocated heap: nothing pre-initialises the label space, so the sixth value costs
 * zero series until a rejection actually occurs.
 */
export const BRIDGE_MESSAGE_OUTCOMES = [
  'handled',
  'no_handler',
  'rate_limited',
  'deduped',
  'no_token',
  'validator_rejected',
] as const;
export type BridgeMessageOutcome = (typeof BRIDGE_MESSAGE_OUTCOMES)[number];

/**
 * Which host registered the bridge. Deliberately the `hostHandlerParity` FILE
 * names rather than a prettier short form: the parity inventory's per-host
 * requirement columns are keyed on exactly these strings, so a `no_handler` series
 * can be read straight against `INVENTORY[type][host]` with no mapping table in
 * between. (`InlineHost` is absent because the v1 stub wires no bridge.)
 */
export const BRIDGE_HOSTS = ['IframeHost', 'PageBlockHost'] as const;
export type BridgeHost = (typeof BRIDGE_HOSTS)[number];

/**
 * Most rows one beacon request may carry. The client slices to this and the
 * server's zod schema rejects above it — ONE constant, read by both, because the
 * failure mode of a mismatch is silent: the server rejects the WHOLE batch, so a
 * client slicing higher than the server accepts loses every good row with the bad
 * one and nothing surfaces. Same reasoning and the same shape as
 * `TRACK_BATCH_MAX`, which `trackEventBuffer.ts` imports from the schema for
 * exactly this.
 */
export const BRIDGE_MESSAGE_BATCH_MAX = 200;

/**
 * Largest `count` one row may carry — a CLAMP on the client and a REJECT on the
 * server.
 *
 * 🔴 IT IS A SANITY CEILING, NOT A RATE CONTROL, AND THE DIFFERENCE MATTERS. An
 * earlier revision of this comment derived it as "30 msg/sec × a 10 s flush window
 * = 300 legitimate max, so nothing real can reach it". That derivation is wrong
 * for FOUR of the six outcomes and was cited as justification in two other
 * files, so it is corrected here rather than quietly dropped:
 *
 *   - `handled` and `no_token` are the only two the bridge's 30 msg/sec inbound
 *     limiter bounds at all — ~300 per key per 10 s window, and higher than that
 *     whenever the window stretches (see below).
 *   - `no_handler`, `deduped` and `validator_rejected` are reported ABOVE that
 *     limiter, deliberately (a flood of unhandled junk must not burn the budget that
 *     legitimate BLOCK_ERROR reporting needs — see `usePostMessage`).
 *     `validator_rejected` is doubly unbounded: its emitter carries no cap either.
 *   - `rate_limited` is by construction only recorded for messages that exceeded
 *     the budget.
 *
 * So on those four a block in a postMessage loop — a buggy render loop calling an
 * SDK method is the ordinary, non-malicious case — can drive one key far past any
 * cap. The window is not a hard 10 s either: after the first flush a backgrounded
 * tab's `setTimeout` is throttled to 1/s or 1/min.
 *
 * The cap is therefore chosen so that a real flood is still VISIBLE rather than
 * exactly counted: above it the client CLAMPS (never drops the batch, never 400s
 * it), so the series reads "enormous" instead of "wrong". 100,000 is ~333× the
 * limiter-bounded ceiling and well clear of a throttled tab's stretched window, so
 * on the two bounded outcomes it cannot fire at all. On the other four it can, by
 * construction — a block in a `postMessage` loop is exactly the case those
 * outcomes exist to reveal, and truncating a flood to a huge number is the
 * intended outcome rather than a limitation. Do not read the value as a claim
 * about browser throughput; it is a claim about which shape of wrongness we
 * prefer.
 *
 * 🔴 IT DOES NOT BOUND WHAT ONE REQUEST CAN ADD TO A SERIES. Nothing enforces row
 * uniqueness, so a batch may repeat the same label set; the per-request magnitude
 * is `BRIDGE_MESSAGE_BATCH_MAX × this`. The property the beacon route does enforce
 * is CARDINALITY — bounded label values, which is the prom-heap axis. Magnitude is
 * a rate-limit question, and no `/api/track/*` beacon has one.
 */
export const BRIDGE_MESSAGE_COUNT_MAX = 100_000;

/** Copy for the NACK a host sends when it registers no handler for a type. */
export const BRIDGE_NACK_NO_HANDLER = 'unsupported on this host';

/** Copy for the NACK a host sends when it has no usable block credential. */
export const BRIDGE_NACK_NO_TOKEN = 'block credential unavailable';
