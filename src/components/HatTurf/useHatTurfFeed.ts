import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useExperiment } from '~/components/Experiments/useExperiment';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import type { ExperimentVariant } from '~/shared/constants/experiments.constants';

export type HatTurfFeedArm = ExperimentVariant<'hatTurfFeedCard'>;

/**
 * The one place the feed-card flag is read, together with the event being playable for this viewer
 * (the server's call, not the flag's). Null until the viewer's `hatTurfFeedCard` arm is known, so
 * nobody sees one arm and then the other.
 */
export function useHatTurfFeed(): { event: string; arm: HatTurfFeedArm } | null {
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration('Image', features.hatTurfFeedCard);
  const live = !!features.hatTurfFeedCard && !!definition;
  const experiment = useExperiment('hatTurfFeedCard', { enabled: live });
  return live && definition && experiment.ready
    ? { event: definition.event, arm: experiment.variant }
    : null;
}
