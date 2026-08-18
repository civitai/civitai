import { useEffect, useRef } from 'react';
import { useAdsContext } from '~/components/Ads/AdsProvider';
// import { useAdsContext } from '~/components/Ads/AdsProvider';
import { useBrowsingLevelDebounced } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import type { AddViewSchema } from '~/server/schema/track.schema';
import { removeEmpty } from '~/utils/object-helpers';

// Fire a view event at the lightweight /api/internal/pulse beacon instead of the
// track.addView tRPC mutation. addView was the #1 request-count source on
// api-primary (~71 req/s) and paid the full tRPC middleware chain + superjson
// encode per call for an empty, fire-and-forget response. The beacon route runs
// the same Tracker.view() (same ClickHouse `views` insert, same payload shape)
// without any of that fixed per-request cost. `keepalive: true` lets the request
// survive a page unload/navigation (mirrors /api/internal/ping), so the event isn't
// lost if the user clicks through immediately after the 1s debounce fires. The
// path is deliberately generic (not "track"/"view") so ad/privacy blockers don't
// cancel it client-side with ERR_BLOCKED_BY_CLIENT.
function sendView(input: AddViewSchema) {
  void fetch('/api/internal/pulse', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(removeEmpty(input)),
  }).catch(() => {
    // Fire-and-forget telemetry: a failed beacon must never surface to the user
    // or throw an unhandled rejection. The server side already retries/logs.
  });
}

/**
 * `delayMs` is the intent filter: a page the viewer bounced off within the window is not a view.
 * The 1s default is right when the component mounts with the page. It is too long when the
 * component is gated behind a slow query — that wait already filters bounces, and charging another
 * second on top pushed the effective threshold to ~5-6s on the comic reader and silently lost ~50%
 * of its views. Lower it at that call site rather than for everyone.
 *
 * ⚠️ Lower, not zero. The query wait only filters the FIRST render; an entityId change within an
 * already-mounted component (a shallow route change over data that is already loaded) has no wait
 * in front of it at all, so 0 counts every keypress of a held arrow key as a view.
 */
export function TrackView({
  type,
  entityType,
  entityId,
  details,
  nsfw: nsfwOverride,
  nsfwLevel,
  delayMs = 1000,
}: AddViewSchema & { delayMs?: number }) {
  const observedEntityId = useRef<number | null>(null);
  const { adsEnabled, adsBlocked, useDirectAds } = useAdsContext();

  const nsfw = useBrowsingSettings((x) => x.showNsfw);
  const browsingLevel = useBrowsingLevelDebounced();

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (entityId !== observedEntityId.current) {
        observedEntityId.current = entityId;
        sendView({
          type,
          entityType,
          entityId,
          details,
          // Direct ads on .red are tracked separately; only report Snigel/programmatic ad status here.
          ads: useDirectAds ? 'Off' : adsBlocked ? 'Blocked' : adsEnabled ? 'Served' : 'Off',
          nsfw: nsfwOverride ?? nsfw,
          browsingLevel,
          nsfwLevel,
        });
      }
    }, delayMs);
    return () => {
      clearTimeout(timeout);
    };
  }, [entityId, type, entityType, details, delayMs]);

  return null;
}

// function useAdViewSatus() {
//   const { isMember, enabled, adsBlocked } = useAdsContext();
//   if (isMember) return 'Member';
//   if (!enabled) return 'Off';
//   if (adsBlocked) return 'Blocked';
//   return 'Served';
// }
