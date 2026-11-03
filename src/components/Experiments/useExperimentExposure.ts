import { useEffect } from 'react';
import { useInView } from 'react-intersection-observer';
import { useTrackEvent } from '~/components/TrackView/track.utils';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import type { ExperimentKey, ExperimentSurface } from '~/shared/constants/experiments.constants';
import { useExperiment } from './useExperiment';

const STORAGE_KEY = 'experiment-exposures';
const sentThisTab = new Set<string>();

// One row per (user, experiment, UTC day). The readout counts users, so this only keeps volume
// down; a cleared storage or a second device adds rows, not users.
function claimExposure(userId: number, key: ExperimentKey): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const id = `${userId}:${key}`;
  if (sentThisTab.has(`${day}:${id}`)) return false;
  sentThisTab.add(`${day}:${id}`);
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as {
      day: string;
      seen: string[];
    } | null;
    const seen = stored?.day === day ? stored.seen : [];
    if (seen.includes(id)) return false;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ day, seen: [...seen, id] }));
  } catch {
    // Storage unavailable: the per-tab set still holds.
  }
  return true;
}

/**
 * Logs that the viewer saw their arm of `key`. Attach the returned ref to the experimental UI;
 * it fires once half of it is on screen. Signed-out viewers are not in experiments and log nothing.
 */
export function useExperimentExposure(key: ExperimentKey, surface: ExperimentSurface) {
  const experiment = useExperiment(key);
  const currentUser = useCurrentUser();
  const { trackAction } = useTrackEvent();
  const inExperiment = experiment.ready && experiment.assignment !== 'signed-out';
  const { ref, inView } = useInView({ threshold: 0.5, triggerOnce: true, skip: !inExperiment });

  const { variant, assignment } = experiment;
  const userId = currentUser?.id;
  useEffect(() => {
    if (!inView || !userId || !variant || !assignment || assignment === 'signed-out') return;
    if (!claimExposure(userId, key)) return;
    trackAction({
      type: 'Experiment_Exposure',
      details: { exp: key, variant, assignment, surface },
    }).catch(() => undefined);
  }, [inView, userId, key, variant, assignment, surface, trackAction]);

  return ref;
}

export function resetExperimentExposuresForTests() {
  sentThisTab.clear();
}
