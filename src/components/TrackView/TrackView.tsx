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

export function TrackView({
  type,
  entityType,
  entityId,
  details,
  nsfw: nsfwOverride,
  nsfwLevel,
}: AddViewSchema) {
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
    }, 1000);
    return () => {
      clearTimeout(timeout);
    };
  }, [entityId, type, entityType, details]);

  return null;
}

// function useAdViewSatus() {
//   const { isMember, enabled, adsBlocked } = useAdsContext();
//   if (isMember) return 'Member';
//   if (!enabled) return 'Off';
//   if (adsBlocked) return 'Blocked';
//   return 'Served';
// }
