import {
  BRIDGE_MESSAGE_BATCH_MAX,
  BRIDGE_MESSAGE_COUNT_MAX,
  type BridgeHost,
  type BridgeMessageOutcome,
} from './bridgeLabels';
import { boundBridgeMessageType } from './bridgeTelemetry';

/**
 * App Blocks bridge-message beacon (client half) — a COALESCING COUNTER, not an
 * event log.
 *
 * 🔴 WHY IT AGGREGATES INSTEAD OF MIRRORING `/api/track/block-render` ONE-FOR-ONE.
 * The render beacon fires ONCE PER HOST MOUNT; this one sits on the inbound path
 * of a bridge whose own rate limit is 30 messages/sec/host. A request-per-message
 * beacon would therefore be a ~30 req/s/tab telemetry channel on a surface whose
 * whole point is that it is cheap — and a polling generator app (POLL_WORKFLOW on
 * a tick) is the common case, not the worst case. The quantity prom needs is a
 * COUNT, and a count is exactly what survives aggregation losslessly: N messages
 * over a flush window collapse to at most one row per distinct
 * {appBlockId, type, host, outcome}, and the server increments the counter BY that
 * count. The series is byte-identical to what a per-message beacon would produce.
 *
 * NO LOSS ON NAVIGATION. Flushes on a timer, on a distinct-key cap, and on
 * `pagehide` / `visibilitychange:hidden` via `navigator.sendBeacon`, which the
 * browser delivers as the document is torn down (a plain fetch is cancelled).
 * `unload`/`beforeunload` are deliberately not used — they disable the bfcache and
 * do not fire on mobile. Same pair as `trackEventBuffer.ts`.
 *
 * FAIL-OPEN. Nothing here throws to the caller and nothing blocks a bridge
 * message. A failed flush drops its counts rather than retrying: an at-least-once
 * retry on a COUNTER double-counts, which is worse than a small undercount for a
 * series read as a rate.
 */

export type BridgeMessageEvent = {
  appBlockId: string;
  type: string;
  host: BridgeHost;
  outcome: BridgeMessageOutcome;
  count: number;
};

// Deliberately generic path (not "bridge"/"message") so ad/privacy blockers don't
// cancel it with ERR_BLOCKED_BY_CLIENT — same reasoning as /api/internal/pulse and
// /api/track/batch.
const ENDPOINT = '/api/track/block-message';

/**
 * Flush cadence. Longer than `trackEventBuffer`'s 3s because nothing downstream is
 * latency-sensitive: this feeds a prom counter scraped on a 30s-ish cadence, so a
 * 10s coalescing window costs nothing and cuts the request count by another ~3x.
 */
const FLUSH_INTERVAL_MS = 10_000;

/**
 * Distinct-key cap — a SAFETY BOUND on the browser-side map, not a tuning knob.
 * The key space is (apps on the page) x (47 protocol types + other) x (2 hosts) x
 * (6 outcomes), and a page hosts one or two blocks, so a real page sits in the low
 * tens. Hitting this cap means something is generating unbounded distinct types
 * (they clamp to `other` server-side, so prom is safe either way) — flush early and
 * keep the map small rather than grow it.
 */
const FLUSH_AT_DISTINCT_KEYS = 64;

const counts = new Map<string, BridgeMessageEvent>();
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function keyOf(e: Omit<BridgeMessageEvent, 'count'>): string {
  // \u0000 as the join, WRITTEN AS THE ESCAPE. The separator has to be a character
  // no component can contain — one that can silently merges two distinct label
  // sets into a single row — and a space would not do, because `appBlockId` is
  // host-supplied rather than enum-bounded. But a LITERAL NUL in a source file is
  // its own defect: recursive ripgrep drops the whole file from its results with
  // no diagnostic, so a later search over it returns a false negative
  // indistinguishable from an absence. `src/__tests__/source-nul-bytes.test.ts`
  // is the guard for that, and it caught exactly this here. The escape is
  // byte-identical at runtime.
  return `${e.appBlockId}\u0000${e.type}\u0000${e.host}\u0000${e.outcome}`;
}

function bindLifecycleListeners() {
  if (listenersBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  listenersBound = true;
  const onHidden = () => {
    if (document.visibilityState === 'hidden') flushBridgeMessages();
  };
  document.addEventListener('visibilitychange', onHidden);
  window.addEventListener('pagehide', () => flushBridgeMessages());
}

function scheduleFlush() {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flushBridgeMessages();
  }, FLUSH_INTERVAL_MS);
}

function post(body: string): void {
  try {
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.sendBeacon === 'function' &&
      // Blob type sets Content-Type: application/json so the route's body parser
      // reads it as JSON (same as a fetch with that header).
      navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }))
    ) {
      return;
    }
  } catch {
    // fall through to fetch
  }
  void fetch(ENDPOINT, {
    method: 'POST',
    // keepalive lets a flush that races a navigation still complete.
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body,
  }).catch(() => {
    // Fire-and-forget telemetry: never surface to the user, never throw an
    // unhandled rejection.
  });
}

/**
 * Record ONE bridge-message outcome. Cheap, synchronous, and safe to call from the
 * dispatcher's hot path — it touches a Map and (at most) arms a timer.
 */
export function recordBridgeMessage(raw: Omit<BridgeMessageEvent, 'count'>): void {
  if (typeof window === 'undefined') return;
  bindLifecycleListeners();
  // 🔴 CLAMP THE TYPE AT THE BUFFER'S DOOR, not only at the server's. `type`
  // arrives as the block's own `data.type` string — arbitrary length, arbitrary
  // value, and on the unhandled-message path it is not even behind the 30 msg/sec
  // inbound limiter (that branch sits ahead of it, deliberately). Buffering it raw
  // has two failure modes and both are silent: a block posting unique junk types
  // mints a new key per message, trips `FLUSH_AT_DISTINCT_KEYS` every 64th, and
  // converts an inbound message flood into an outbound POST flood; and an
  // over-length `type` fails the server's `max(128)`, which rejects the WHOLE
  // batch, destroying every legitimate count flushed with it. Clamping here
  // collapses all junk onto the single `other` key that prom would have bucketed
  // it into anyway, so nothing observable is lost.
  // …and bound `appBlockId` the same way, for the same all-or-nothing reason. It is
  // host-supplied rather than block-supplied, so this is a belt rather than the
  // clamp above — but it is the only field left that could fail its server-side
  // schema (`z.string().trim().min(1).max(256)`) and take a whole batch's worth of
  // good counts down with it. 🔴 TWO WAYS, not one: over-length, and — because
  // zod's `.trim()` runs BEFORE `.min(1)` — whitespace-only, which is truthy here
  // and so would sail past a bare `|| 'other'`. Hence `.trim()` first. The server
  // clamps the VALUE to the approved-app set anyway, so a clamped and an unclamped
  // unknown id produce the same `other` label; only the schema failure is
  // destructive.
  const event = {
    ...raw,
    appBlockId: raw.appBlockId.trim().slice(0, 256) || 'other',
    type: boundBridgeMessageType(raw.type),
  };
  const key = keyOf(event);
  const existing = counts.get(key);
  if (existing) existing.count += 1;
  else counts.set(key, { ...event, count: 1 });
  if (counts.size >= FLUSH_AT_DISTINCT_KEYS) {
    flushBridgeMessages();
    return;
  }
  scheduleFlush();
}

/** Send whatever is buffered now. No-op when empty. Exported for the unload path. */
export function flushBridgeMessages(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (counts.size === 0) return;
  // 🔴 CLAMP `count` TOO, for the same all-or-nothing reason: a row above the
  // schema's ceiling 400s the whole batch, taking every good row with it. Where it
  // fires the series reads "enormous" instead of "rejected" — see
  // `BRIDGE_MESSAGE_COUNT_MAX` for why the ceiling is a SANITY bound and not, as
  // an earlier revision of this comment claimed, a figure no real client can
  // reach: four of the six outcomes are reported above the bridge's inbound
  // limiter and are not bounded by it at all.
  const events = [...counts.values()]
    .slice(0, BRIDGE_MESSAGE_BATCH_MAX)
    .map((e) =>
      e.count > BRIDGE_MESSAGE_COUNT_MAX ? { ...e, count: BRIDGE_MESSAGE_COUNT_MAX } : e
    );
  counts.clear();
  post(JSON.stringify({ events }));
}

/** Test-only: drop everything buffered without sending it. */
export const _internalsForTests = {
  reset(): void {
    counts.clear();
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  },
  /** Test-only: is the flush timer currently armed? */
  timerArmed(): boolean {
    return timer !== null;
  },
  buffered(): BridgeMessageEvent[] {
    return [...counts.values()];
  },
};
