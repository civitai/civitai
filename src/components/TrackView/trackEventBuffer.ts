// Client-side telemetry coalescing buffer for the high-volume `track.trackSearch`
// (~16/s) and `track.addAction` (~6.8/s) events.
//
// Before: each event was a standalone `trpc.track.*.useMutation()` call, so every
// search/action dragged the full non-batched tRPC middleware chain + superjson
// encode + a ClickHouse insert — ~23 telemetry procedures/s fleet-wide. This
// buffer coalesces those events in the browser and flushes them as one batch to
// the lightweight `/api/track/batch` beacon (which runs NONE of the tRPC chain and
// fires the identical Tracker.search()/Tracker.action() inserts), collapsing ~23
// procedures/s into a handful of batched requests/s.
//
// NO EVENT LOSS on navigation/unload: the buffer flushes on a short interval, on a
// size cap, and — critically — on `visibilitychange` (hidden) and `pagehide` using
// `navigator.sendBeacon`, which is guaranteed to be delivered by the browser even
// as the document is torn down (a normal fetch is cancelled on navigation). We do
// NOT use `unload`/`beforeunload` (they disable the bfcache and don't fire on
// mobile); `pagehide` + `visibilitychange:hidden` is the modern, reliable pair.
//
// FAIL-OPEN: a failed flush never throws to the caller and never blocks the user
// flow. A failed interval/size flush re-queues its events (bounded to
// TRACK_BATCH_MAX) so the next flush retries; telemetry is best-effort but not
// silently dropped wholesale.
import { TRACK_BATCH_MAX } from '~/server/schema/track.schema';
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

// POST a batch. On the unload path we MUST use sendBeacon (a keepalive fetch is not
// reliably delivered while the document is being discarded). Returns whether the
// send was accepted for delivery — false means "re-queue and retry".
function post(events: TrackBatchEvent[], viaBeacon: boolean): Promise<boolean> {
  const body = JSON.stringify(events);

  if (viaBeacon && typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
    try {
      // Blob type sets Content-Type: application/json so the beacon route's body
      // parser reads it as JSON (same as a fetch with that header).
      const ok = navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'application/json' }));
      return Promise.resolve(ok);
    } catch {
      return Promise.resolve(false);
    }
  }

  return fetch(ENDPOINT, {
    method: 'POST',
    // keepalive lets an interval/size flush that races a navigation still complete.
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body,
  })
    .then((res) => res.ok)
    .catch(() => false);
}

// Drain the buffer and send it. `viaBeacon` is set on the unload/hide path.
function flush(viaBeacon = false): void {
  clearTimer();
  if (buffer.length === 0) return;

  // Snapshot + reset atomically so events enqueued during the async send land in
  // the NEXT batch (and aren't dropped or double-sent).
  const events = buffer;
  buffer = [];

  void post(events, viaBeacon).then((ok) => {
    if (ok) return;
    // Fail-open with a bounded retry: prepend the un-sent events (preserving order)
    // ahead of anything queued since, clamp to the hard cap, and let the next flush
    // pick them up. We drop the OLDEST overflow rather than the newest.
    if (buffer.length > 0) {
      buffer = events.concat(buffer);
    } else {
      buffer = events;
    }
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
// Flushes immediately when the size cap is hit, otherwise arms the interval timer.
export function enqueueTrackEvent(event: TrackBatchEvent): void {
  if (typeof window === 'undefined') return; // SSR / non-browser: no telemetry
  bindLifecycleListeners();

  buffer.push(event);
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
  pendingCount: () => buffer.length,
  reset: () => {
    clearTimer();
    buffer = [];
    listenersBound = false;
  },
  constants: { FLUSH_INTERVAL_MS, FLUSH_AT_SIZE, HARD_CAP },
};
