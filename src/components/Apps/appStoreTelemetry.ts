import { useCallback, useEffect, useRef } from 'react';
import {
  impressionTelemetryOn,
  useDwellImpression,
} from '~/components/TrackView/useTrackImpression';
import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
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

// Gated by the same dial as impressions, or click-through ratios inflate.
export function useAppStoreTelemetryOn(): boolean {
  return impressionTelemetryOn(useOptionalFeatureFlags());
}

/** The gated recorder for clicks: a no-op while the funnel's gate is off. */
export function useTrackAppStoreAction() {
  const on = useAppStoreTelemetryOn();
  return useCallback(
    (action: AppStoreActionKind, listingId: string, t: AppStoreTelemetry) => {
      if (on) trackAppStoreAction(action, listingId, t);
    },
    [on]
  );
}

/** Fire-and-forget: queue one `AppStore_Action` on the shared beacon. Ungated — use the hook. */
export function trackAppStoreAction(
  action: AppStoreActionKind,
  listingId: string,
  t: AppStoreTelemetry
): void {
  const details = appStoreActionDetails(action, listingId, t);
  if (!details) return;
  enqueueTrackEvent({ kind: 'action', data: { type: 'AppStore_Action', details } });
}

// Once per listing per surface per page view: keyed on the pathname, so a sort/filter change on
// the same page does not re-count.

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

/**
 * A ref that records ONE `impression` for this card once it has been half-visible for a second.
 * `telemetry` undefined (a moderator preview, an untracked placement) watches nothing.
 */
export function useAppStoreImpression<T extends HTMLElement = HTMLDivElement>(
  listingId: string,
  telemetry: AppStoreTelemetry | undefined
) {
  // Read when the dwell matures, so the event carries the card's position / filters at that moment.
  const latest = useRef(telemetry);
  latest.current = telemetry;
  return useDwellImpression<T>(telemetry ? `${telemetry.surface}:${listingId}` : undefined, () => {
    const t = latest.current;
    if (!t || !claimImpression(t.surface, listingId)) return;
    trackAppStoreAction('impression', listingId, t);
  });
}

/**
 * One `detail_view` per mount of a listing's detail page (and again if the page swaps to another
 * listing). `enabled` false — a moderator preview — records nothing.
 */
export function useAppStoreDetailView(listingId: string | null | undefined, enabled: boolean) {
  const on = useAppStoreTelemetryOn();
  useEffect(() => {
    if (!on || !enabled || !listingId) return;
    trackAppStoreAction('detail_view', listingId, { surface: 'detail' });
  }, [on, enabled, listingId]);
}
