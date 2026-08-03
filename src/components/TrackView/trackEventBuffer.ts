// Client-side telemetry coalescing buffer for the high-volume `track.trackSearch`
// (~16/s) and `track.addAction` (~6.8/s) events.
//
// Before: each event was a standalone `trpc.track.*.useMutation()` call, so every
// search/action dragged the full non-batched tRPC middleware chain + superjson
// encode + a ClickHouse insert — ~23 telemetry procedures/s fleet-wide. This
// buffer coalesces those events in the browser and flushes them as batches to the
// lightweight `/api/track/batch` beacon (which runs NONE of the tRPC chain and
// fires the identical Tracker.search()/Tracker.action() inserts), collapsing ~23
// procedures/s into a handful of batched requests/s.
//
// NO EVENT LOSS on navigation/unload: the buffer flushes on a short interval, on a
// size cap, on enqueue of an immediate-flush event, and — critically — on
// `visibilitychange` (hidden) and `pagehide` using `navigator.sendBeacon`, which
// the browser delivers even as the document is torn down (a normal fetch is
// cancelled on navigation). We do NOT use `unload`/`beforeunload` (they disable the
// bfcache and don't fire on mobile); `pagehide` + `visibilitychange:hidden` is the
// modern, reliable pair.
//
// OVERSIZED BATCHES: `navigator.sendBeacon` (and the shared keepalive-fetch budget)
// cap out around ~64KB. A large or re-queued batch is split into sub-batches that
// each fit under the cap and sent as multiple requests; if a beacon is still
// refused (returns false), we fall back to a keepalive fetch for that chunk rather
// than silently dropping it.
//
// AT-LEAST-ONCE / FAIL-OPEN: a failed flush never throws to the caller and never
// blocks the user flow. Failed chunks are re-queued (bounded to TRACK_BATCH_MAX)
// so the next flush retries; telemetry is best-effort but not silently dropped
// wholesale. Because an ambiguous failure (e.g. a request that actually reached the
// server but whose response was lost) is retried, delivery is AT-LEAST-ONCE — CH
// rows can duplicate, so consumers must dedup (high-value events on
// externalId/session; see the beacon route + PR notes).
import { TRACK_BATCH_MAX, isImmediateFlushTrackEvent } from '~/server/schema/track.schema';
import type { TrackBatchEvent } from '~/server/schema/track.schema';

// Deliberately generic path (not "track"/"search"/"action") so ad/privacy blockers
// don't cancel it with ERR_BLOCKED_BY_CLIENT — same reasoning as /api/internal/pulse.
const ENDPOINT = '/api/track/batch';

// Flush cadence. A few seconds of coalescing is the only user-visible delta and is
// imperceptible. Size cap flushes early under a burst so the buffer never grows
// large in memory; the hard cap bounds re-queued events after a failed flush.
const FLUSH_INTERVAL_MS = 3000;
const FLUSH_AT_SIZE = 20;
const HARD_CAP = TRACK_BATCH_MAX; // never hold/POST more than the server accepts

// Keep each request comfortably under the ~64KB sendBeacon / keepalive-fetch cap.
// A flush whose serialized events exceed this is split into multiple sub-requests.
const MAX_BEACON_BYTES = 60000;

const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
function byteLength(str: string): number {
  return textEncoder ? textEncoder.encode(str).length : str.length;
}

let buffer: TrackBatchEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleTimer() {
  if (timer !== null) return; // an interval flush is already pending
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_INTERVAL_MS);
}

// Split events into ordered sub-batches that each fit under MAX_BEACON_BYTES (and
// the server's per-request count cap). A single event larger than the cap can't be
// split further — it goes out alone (best effort).
function chunkEvents(events: TrackBatchEvent[]): TrackBatchEvent[][] {
  const chunks: TrackBatchEvent[][] = [];
  let current: TrackBatchEvent[] = [];
  let currentBytes = 2; // "[]"

  for (const event of events) {
    const eventBytes = byteLength(JSON.stringify(event)) + 1; // + comma separator
    const wouldOverflow = currentBytes + eventBytes > MAX_BEACON_BYTES;
    const wouldExceedCount = current.length >= TRACK_BATCH_MAX;
    if (current.length > 0 && (wouldOverflow || wouldExceedCount)) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function postBeacon(body: string): boolean {
  try {
    // Blob type sets Content-Type: application/json so the beacon route's body
    // parser reads it as JSON (same as a fetch with that header).
    return navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
  } catch {
    return false;
  }
}

function postFetch(body: string): Promise<boolean> {
  return fetch(ENDPOINT, {
    method: 'POST',
    // keepalive lets a flush that races a navigation still complete.
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then((res) => res.ok)
    .catch(() => false);
}

// Send ONE chunk. On the unload path we prefer sendBeacon (a keepalive fetch is not
// reliably delivered while the document is discarded); if the beacon is REFUSED
// (returns false — over the cap, or the browser's beacon queue is full) we fall
// back to a keepalive fetch rather than dropping the chunk. Returns whether the
// chunk was accepted for delivery.
function sendChunk(chunk: TrackBatchEvent[], viaBeacon: boolean): Promise<boolean> {
  const body = JSON.stringify(chunk);
  if (viaBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    if (postBeacon(body)) return Promise.resolve(true);
    // Beacon refused → best-effort keepalive fetch fallback.
    return postFetch(body);
  }
  return postFetch(body);
}

// Drain the buffer and send it (chunked). `viaBeacon` is set on the unload/hide
// path. Failed chunks are re-queued (order-preserved, bounded) for the next flush.
function flush(viaBeacon = false): void {
  clearTimer();
  if (buffer.length === 0) return;

  // Snapshot + reset atomically so events enqueued during the async send land in
  // the NEXT batch (and aren't dropped or double-sent within this flush).
  const events = buffer;
  buffer = [];
  const chunks = chunkEvents(events);

  void Promise.all(
    chunks.map((chunk) => sendChunk(chunk, viaBeacon).then((ok) => (ok ? [] : chunk)))
  ).then((failedGroups) => {
    // `failedGroups` preserves chunk order, so flattening restores event order.
    const failed = failedGroups.flat();
    if (failed.length === 0) return;
    // Fail-open with a bounded retry: prepend the un-sent events (older) ahead of
    // anything queued since, clamp to the hard cap (drop OLDEST overflow), and let
    // the next flush pick them up.
    buffer = buffer.length > 0 ? failed.concat(buffer) : failed;
    if (buffer.length > HARD_CAP) buffer = buffer.slice(buffer.length - HARD_CAP);
    if (buffer.length > 0) scheduleTimer();
  });
}

function bindLifecycleListeners() {
  if (listenersBound || typeof document === 'undefined' || typeof window === 'undefined') return;
  listenersBound = true;

  // `visibilitychange -> hidden` is the reliable "user is leaving" signal on mobile
  // (pagehide/unload often don't fire there). Flush via beacon so nothing is lost.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush(true);
  });
  // Desktop navigation / tab close. Beacon survives the teardown.
  window.addEventListener('pagehide', () => flush(true));
}

// Enqueue one telemetry event. Synchronous, never throws, no-ops on the server.
//
// Immediate-flush events (see IMMEDIATE_FLUSH_ACTION_TYPES — money/conversion +
// compliance-critical) are NEVER held: they trigger an immediate flush in the same
// tick so a browser crash can't lose them (sendBeacon only covers navigation/tab-
// hide, not a crash). They still go out the SAME /api/track/batch transport,
// batched with whatever low-value events are already buffered — the point is they
// aren't delayed by the interval.
//
// Low-value events (all searches + high-volume top-of-funnel clicks) coalesce:
// flush on the size cap, otherwise arm the interval timer.
export function enqueueTrackEvent(event: TrackBatchEvent): void {
  if (typeof window === 'undefined') return; // SSR / non-browser: no telemetry
  bindLifecycleListeners();

  buffer.push(event);

  if (isImmediateFlushTrackEvent(event)) {
    flush(); // conversion/compliance event — leave now, don't wait for the interval
    return;
  }

  if (buffer.length >= FLUSH_AT_SIZE) {
    flush();
  } else {
    scheduleTimer();
  }
}

// Test-only hooks. Not part of the runtime contract — let tests drive the buffer
// deterministically (inspect pending count, force a flush, reset module state).
export const __trackBufferTestHooks = {
  flush,
  chunkEvents,
  pendingCount: () => buffer.length,
  reset: () => {
    clearTimer();
    buffer = [];
    listenersBound = false;
  },
  constants: { FLUSH_INTERVAL_MS, FLUSH_AT_SIZE, HARD_CAP, MAX_BEACON_BYTES },
};
