import { useCallback, useEffect, useRef } from 'react';
import { enqueueTrackEvent } from '~/components/TrackView/trackEventBuffer';
import type { ListingSort } from '~/server/schema/blocks/app-listing-read.schema';
import type { TrackActionInput } from '~/server/schema/track.schema';
import { isMarketplaceCategory } from '~/server/services/blocks/marketplace-categories.constants';
import {
  APP_STORE_LISTING_ID_RE,
  APP_STORE_POSITION_MAX,
  storeQueryLengthBucket,
  type AppStoreActionKind,
  type AppSurface,
} from '~/shared/utils/app-store-telemetry';

/**
 * The browser half of the `AppStore_Action` funnel (impression → card_click / cta_click →
 * detail_view). Every row goes through the shared coalescing beacon (`enqueueTrackEvent` →
 * `/api/track/batch`), so a screenful of impressions is one request, not one per card.
 *
 * The public counters are NOT here: on-site plays (`App_Open`) and off-site visits
 * (`App_Visit`) are written server-side by the run route and the `/apps/go` redirect, so no
 * script can inflate them through this module.
 */

/** Where a card is rendered, and the store grid state it was rendered under. */
export type AppStoreTelemetry = {
  surface: AppSurface;
  /** Zero-based index in the grid / rail. */
  position?: number;
  sort?: ListingSort;
  /** The store's category FILTER (null = all), not the card's own category. */
  category?: string | null;
  /**
   * The store search box's text. Reduced to `hasQuery` + a length bucket here; the text itself
   * never leaves this module.
   */
  query?: string | null;
};

type AppStoreActionDetails = Extract<TrackActionInput, { type: 'AppStore_Action' }>['details'];

/**
 * The exact `details` one event carries. Pure: fields are dropped rather than sent invalid, so a
 * single bad value (a non-store category, an out-of-range position) cannot make the server
 * reject the whole beacon batch it rides in.
 */
export function appStoreActionDetails(
  action: AppStoreActionKind,
  listingId: string,
  t: AppStoreTelemetry
): AppStoreActionDetails | null {
  if (!APP_STORE_LISTING_ID_RE.test(listingId)) return null;
  const details: AppStoreActionDetails = { action, listingId, surface: t.surface };
  if (
    typeof t.position === 'number' &&
    Number.isInteger(t.position) &&
    t.position >= 0 &&
    t.position <= APP_STORE_POSITION_MAX
  )
    details.position = t.position;
  if (t.sort) details.sort = t.sort;
  if (isMarketplaceCategory(t.category)) details.category = t.category;
  // Only grid placements carry search state; a surface with no search box sends neither field.
  if (t.query !== undefined) {
    const queryLength = storeQueryLengthBucket(t.query);
    details.hasQuery = queryLength !== '0';
    details.queryLength = queryLength;
  }
  return details;
}

/** Fire-and-forget: queue one `AppStore_Action` on the shared beacon. */
export function trackAppStoreAction(
  action: AppStoreActionKind,
  listingId: string,
  t: AppStoreTelemetry
): void {
  const details = appStoreActionDetails(action, listingId, t);
  if (!details) return;
  enqueueTrackEvent({ kind: 'action', data: { type: 'AppStore_Action', details } });
}

// ── Impressions ────────────────────────────────────────────────────────────────────────────
//
// What counts as one, mirroring the feed impression rule (`useTrackImpression`): at least HALF
// the card visible for a continuous SECOND. Once per listing per surface per PAGE VIEW — the
// seen-set is keyed on the pathname, so a sort or filter change on the same page (a shallow
// query change) does not re-count cards already seen, while navigating away and back does.

const VISIBLE_FRACTION = 0.5;
const DWELL_MS = 1000;

const seen = new Set<string>();
let seenPath: string | null = null;

function currentPath(): string {
  return typeof window === 'undefined' ? '' : window.location.pathname;
}

/**
 * True the first time `surface:listingId` is claimed on the current page view, false after.
 * Exported for tests.
 */
export function claimImpression(surface: AppSurface, listingId: string, path = currentPath()) {
  if (path !== seenPath) {
    seen.clear();
    seenPath = path;
  }
  const key = `${surface}:${listingId}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

export const __appStoreImpressionTestHooks = {
  reset: () => {
    seen.clear();
    seenPath = null;
  },
};

type Watched = {
  fire: () => void;
  timer: ReturnType<typeof setTimeout> | null;
};

let observer: IntersectionObserver | null = null;
const watched = new Map<Element, Watched>();

function getObserver(): IntersectionObserver | null {
  if (observer) return observer;
  if (typeof window === 'undefined' || typeof IntersectionObserver === 'undefined') return null;
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const w = watched.get(entry.target);
        if (!w) continue;
        const visible = entry.isIntersecting && entry.intersectionRatio >= VISIBLE_FRACTION;
        if (visible && w.timer === null) {
          const element = entry.target;
          w.timer = setTimeout(() => {
            w.timer = null;
            // A hidden tab keeps its entries intersecting; a dwell that matured while nobody
            // was looking is not an impression. Wait for the next intersection change.
            if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
            w.fire();
            observer?.unobserve(element);
            watched.delete(element);
          }, DWELL_MS);
        } else if (!visible && w.timer !== null) {
          clearTimeout(w.timer);
          w.timer = null;
        }
      }
    },
    { threshold: [0, VISIBLE_FRACTION, 1] }
  );
  return observer;
}

/**
 * A ref callback that records ONE impression for this card once it has been half-visible for a
 * second. `telemetry` undefined (a moderator preview, an untracked placement) records nothing.
 */
export function useAppStoreImpression(listingId: string, telemetry: AppStoreTelemetry | undefined) {
  // The latest telemetry, read when the dwell matures (its position / filters at that moment).
  const latest = useRef(telemetry);
  latest.current = telemetry;
  const element = useRef<Element | null>(null);
  const enabled = !!telemetry;

  const detach = useCallback(() => {
    const el = element.current;
    if (!el) return;
    const w = watched.get(el);
    if (w?.timer) clearTimeout(w.timer);
    watched.delete(el);
    observer?.unobserve(el);
    element.current = null;
  }, []);

  useEffect(() => detach, [detach]);

  return useCallback(
    (node: Element | null) => {
      detach();
      if (!node || !enabled) return;
      const obs = getObserver();
      if (!obs) return;
      element.current = node;
      watched.set(node, {
        timer: null,
        fire: () => {
          const t = latest.current;
          if (!t || !claimImpression(t.surface, listingId)) return;
          trackAppStoreAction('impression', listingId, t);
        },
      });
      obs.observe(node);
    },
    [detach, enabled, listingId]
  );
}

/**
 * One `detail_view` per mount of a listing's detail page (and again if the page swaps to another
 * listing). `enabled` false — a moderator preview — records nothing.
 */
export function useAppStoreDetailView(listingId: string | null | undefined, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !listingId) return;
    trackAppStoreAction('detail_view', listingId, { surface: 'detail' });
  }, [enabled, listingId]);
}
