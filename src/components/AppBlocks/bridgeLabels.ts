/**
 * App Blocks BRIDGE telemetry — the label sets and wire bounds, and NOTHING ELSE.
 *
 * 🔴 IT IS A SEPARATE MODULE FROM `bridgeTelemetry.ts` FOR ONE MEASURED REASON:
 * `bridgeTelemetry` imports `hostHandlerParity`'s 46-key `INVENTORY` (~6.7 KB
 * minified) to bound the `type` label. `src/server/schema/track.schema.ts` needs
 * the label ENUMS so the beacon's zod schema and the emitter cannot drift — and
 * `track.schema` is imported by `TrackView` on pages that mount no block at all,
 * so importing the INVENTORY-bearing module there would put that payload into
 * bundles that can never use it. Splitting keeps the single-sourcing without the
 * weight.
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
 *
 * 🔴 `no_token` is reported BY THE HANDLER, not by the dispatcher — the dispatcher
 * has no idea a token exists. It rides the same counter because an operator asking
 * "why did this block stall" needs one series, not two.
 */
export const BRIDGE_MESSAGE_OUTCOMES = [
  'handled',
  'no_handler',
  'rate_limited',
  'deduped',
  'no_token',
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
 * 🔴 DERIVED, NOT PICKED. A single key can accumulate at most the bridge's own
 * inbound limit for the length of one flush window: 30 msg/sec × 10 s = 300. The
 * window does not stretch in a backgrounded tab either, because `visibilitychange:
 * hidden` flushes immediately. 2,000 is ~6.6× that ceiling, so no legitimate
 * client can reach it — and because the beacon route is public and carries no rate
 * limit (in common with every sibling `/api/track/*` beacon), the multiplier is
 * also the only ceiling a schema can put on what one request contributes to a
 * single series. Keep it derived from the bridge's own limit rather than rounded
 * up for comfort.
 */
export const BRIDGE_MESSAGE_COUNT_MAX = 2000;

/** Copy for the NACK a host sends when it registers no handler for a type. */
export const BRIDGE_NACK_NO_HANDLER = 'unsupported on this host';

/** Copy for the NACK a host sends when it has no usable block credential. */
export const BRIDGE_NACK_NO_TOKEN = 'block credential unavailable';
