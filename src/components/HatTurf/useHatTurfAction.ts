import { useCallback } from 'react';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import {
  HAT_TURF_EVENTS,
  type ExperimentSurface,
  type HAT_TURF_CLIENT_ACTIONS,
} from '~/shared/constants/experiments.constants';

type HatTurfClientAction = (typeof HAT_TURF_CLIENT_ACTIONS)[number];
type HatTurfEvent = (typeof HAT_TURF_EVENTS)[number];

const isHatTurfEvent = (event: string): event is HatTurfEvent =>
  (HAT_TURF_EVENTS as readonly string[]).includes(event);

/** Logs a Hat Turf UI action for the experiment readout. */
export function useHatTurfAction(surface: ExperimentSurface) {
  const { trackAction } = useTrackEvent();
  return useCallback(
    (action: HatTurfClientAction, event: string) => {
      // The track schema accepts listed events only; an unlisted one would fail the whole batch.
      if (!isHatTurfEvent(event)) return;
      trackAction({ type: 'HatTurf_Action', details: { action, event, surface } }).catch(
        () => undefined
      );
    },
    [trackAction, surface]
  );
}
