import { useCallback } from 'react';
import { enqueueTrackEvent } from '~/components/TrackView/trackEventBuffer';
import { trpc } from '~/utils/trpc';
import type {
  TrackActionInput,
  TrackSearchInput,
  TrackShareInput,
} from '~/server/schema/track.schema';

export const useTrackEvent = () => {
  // trackShare stays a per-event tRPC mutation: it's low-volume (user-intent share
  // clicks) and not part of the high-volume telemetry class B1 targets.
  const { mutateAsync: trackShare } = trpc.track.trackShare.useMutation();

  // React Query keeps `mutateAsync` identity stable across renders via
  // internal refs, so this `useCallback` wrapper actually stabilizes the
  // returned handle for consumers. (Verify by checking React Query's mutation
  // source if the assumption changes — useMutation returns mutateAsync bound to
  // a ref, not a fresh closure per render.)
  const handleTrackShare = useCallback(
    (data: TrackShareInput) => trackShare(data),
    [trackShare]
  );

  // trackAction (~6.8/s) and trackSearch (~16/s) are the high-volume telemetry
  // mutations. Instead of one tRPC call per event (full middleware chain +
  // superjson + ClickHouse insert each), they are coalesced client-side and
  // flushed as one batch to the /api/track/batch beacon (see trackEventBuffer).
  // The event payload is UNCHANGED — only the transport is batched. We return a
  // resolved promise to preserve the existing `.catch(() => …)` fire-and-forget
  // call-site contract (no caller awaits these for control flow). Deps are empty
  // because `enqueueTrackEvent` is a stable module-level function, so the handles
  // stay referentially stable across renders (same guarantee as before).
  const handleTrackAction = useCallback((data: TrackActionInput): Promise<void> => {
    enqueueTrackEvent({ kind: 'action', data });
    return Promise.resolve();
  }, []);

  const handleTrackSearch = useCallback((data: TrackSearchInput): Promise<void> => {
    enqueueTrackEvent({ kind: 'search', data });
    return Promise.resolve();
  }, []);

  return {
    trackShare: handleTrackShare,
    trackAction: handleTrackAction,
    trackSearch: handleTrackSearch,
  };
};
