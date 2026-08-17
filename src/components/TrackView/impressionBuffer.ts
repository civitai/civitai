// Feed impression coalescing — the layer that makes impressions affordable.
//
// An impression is generated roughly every few hundred milliseconds of scrolling.
// Putting that on the wire per entity is the entire risk in this feature, so
// nothing here sends anything: it holds a deduplicated set of entities and hands
// ONE array event to the shared telemetry buffer per flush. Two separate
// reductions are stacked, and both matter:
//
//   1. Set semantics — an entity seen twice in a session is recorded once, so
//      scrolling back up over a feed adds nothing.
//   2. Array batching — a flush of 200 entities is ONE `/api/track/batch` event,
//      not 200. Request rate is therefore set by the flush interval and the
//      number of open feed tabs, and is INDEPENDENT of scroll speed.
//
// The interval is deliberately much longer than the shared buffer's own 3s: an
// impression is the lowest-value event on the site and the highest-volume, so it
// is the one event class that should never arm a fast timer. It rides out on
// whatever flush happens next, and on tab-hide via sendBeacon.
import { generateToken } from '~/utils/string-helpers';
import { enqueueTrackEvent, flushTrackEvents } from '~/components/TrackView/trackEventBuffer';
import { IMPRESSION_ENTITIES_MAX, IMPRESSION_SURFACES } from '~/server/schema/track.schema';
import type { ImpressionEntityType, ImpressionSurface } from '~/server/schema/track.schema';

// 90s of coalescing, and THIS is the dial that sets the feature's request cost.
// With N feed tabs open the added request rate is N/90 per second no matter how
// fast anyone scrolls — see the sizing section of the PR for the estimate. At the
// shared buffer's own 3s it would be thirty times that while describing exactly
// the same set of entities. Impressions also ride along with any flush a search
// or click already triggered, so the marginal cost is below the standalone rate.
const FLUSH_INTERVAL_MS = 90_000;

// Flush early once a flush would fill an event. Purely a bound on how large one
// request gets — a fast scroller hits this before the interval.
const FLUSH_AT_SIZE = IMPRESSION_ENTITIES_MAX;

// Ceiling on the session-dedupe set. A long-lived tab that scrolls tens of
// thousands of entities would otherwise grow this without bound. Past the cap the
// set is cleared rather than grown, which can re-count an entity seen much
// earlier in a very long session; that is the intended trade against a leak.
const SEEN_CAP = 20_000;

// Random per-tab token. NOT an identifier and never persisted — it exists so the
// server can tell "the same tab saw this entity" from "two tabs saw it", which is
// what makes the number deduplicable at read time despite an at-least-once
// transport.
let sessionKey: string | null = null;
function getSessionKey(): string {
  if (!sessionKey) sessionKey = generateToken(16);
  return sessionKey;
}

type EntityKey = string;
const entityKey = (entityType: ImpressionEntityType, entityId: number): EntityKey =>
  `${entityType}:${entityId}`;

const seen = new Set<EntityKey>();
// surface -> entity key -> entity. Keyed by surface because one flush event
// carries a single surface, and a tab can move between feeds within an interval.
const pending = new Map<
  ImpressionSurface,
  Map<EntityKey, { entityType: ImpressionEntityType; entityId: number }>
>();
let pendingCount = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersBound = false;

function clearTimer() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

function scheduleTimer() {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flushImpressions();
  }, FLUSH_INTERVAL_MS);
}

const SURFACES = new Set<string>(IMPRESSION_SURFACES);

// Map a pathname to the closed surface enum. Anything unrecognised is 'other'
// rather than a new value — the column is LowCardinality and the point of the
// enum is that this function cannot widen it.
export function getImpressionSurface(pathname: string): ImpressionSurface {
  if (pathname === '/') return 'home';
  // The first segment names the surface for both a feed (/images) and a detail
  // page hosting one (/models/123 — its gallery is a feed of images).
  const first = pathname.split('/')[1];
  if (first === 'search') return 'search';
  return first && SURFACES.has(first) ? (first as ImpressionSurface) : 'other';
}

// Record that an entity was seen. Synchronous, never throws, no-ops on repeats.
//
// The surface is read from `window.location` HERE rather than passed in from a
// component. Taking it from `useRouter` would subscribe every card on the page to
// route changes, and a router subscription re-renders straight through
// `React.memo` — on a feed that is hundreds of cards re-rendering per navigation,
// which is a steep price for a telemetry label.
export function recordImpression(entityType: ImpressionEntityType, entityId: number): void {
  if (typeof window === 'undefined') return;
  const surface = getImpressionSurface(window.location.pathname);
  const key = entityKey(entityType, entityId);
  if (seen.has(key)) return;

  if (seen.size >= SEEN_CAP) seen.clear();
  seen.add(key);

  bindLifecycleListeners();

  let bySurface = pending.get(surface);
  if (!bySurface) {
    bySurface = new Map();
    pending.set(surface, bySurface);
  }
  bySurface.set(key, { entityType, entityId });
  pendingCount++;

  if (pendingCount >= FLUSH_AT_SIZE) flushImpressions();
  else scheduleTimer();
}

// Move everything pending into the shared telemetry buffer as one event per
// surface (split further only if a surface exceeds the per-event cap).
//
// `viaBeacon` reaches the shared buffer's beacon path rather than a normal fetch;
// it is set on the tab-hide path, where a plain fetch would be cancelled.
export function flushImpressions(viaBeacon = false): void {
  clearTimer();
  if (pendingCount === 0) {
    if (viaBeacon) flushTrackEvents(true);
    return;
  }

  const surfaces = Array.from(pending.entries());
  pending.clear();
  pendingCount = 0;

  const key = getSessionKey();
  for (const [surface, entityMap] of surfaces) {
    const entities = Array.from(entityMap.values());
    for (let i = 0; i < entities.length; i += IMPRESSION_ENTITIES_MAX) {
      enqueueTrackEvent({
        kind: 'impression',
        data: {
          sessionKey: key,
          surface,
          entities: entities.slice(i, i + IMPRESSION_ENTITIES_MAX),
        },
      });
    }
  }

  // Impressions are enqueued but never worth waking the shared buffer for on
  // their own — except on the way out, where "next flush" may not exist.
  if (viaBeacon) flushTrackEvents(true);
}

function bindLifecycleListeners() {
  if (listenersBound || typeof document === 'undefined' || typeof window === 'undefined') return;
  listenersBound = true;

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushImpressions(true);
  });
  window.addEventListener('pagehide', () => flushImpressions(true));
}

// Test-only hooks, mirroring trackEventBuffer's. Not part of the runtime contract.
export const __impressionBufferTestHooks = {
  pendingCount: () => pendingCount,
  seenCount: () => seen.size,
  reset: () => {
    clearTimer();
    pending.clear();
    pendingCount = 0;
    seen.clear();
    sessionKey = null;
    listenersBound = false;
  },
  constants: { FLUSH_INTERVAL_MS, FLUSH_AT_SIZE, SEEN_CAP },
};
