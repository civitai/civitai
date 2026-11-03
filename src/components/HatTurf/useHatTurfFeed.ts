import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useExperiment } from '~/components/Experiments/useExperiment';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The one place the feed-card flag is read, together with the event being playable for this viewer
 * (the server's call, not the flag's). Null until the viewer's `hatTurfFeedCard` arm is known, so
 * nobody sees one arm and then the other.
 */
export function useHatTurfFeed(): { event: string } | null {
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration('Image', features.hatTurfFeedCard);
  const live = !!features.hatTurfFeedCard && !!definition;
  const experiment = useExperiment('hatTurfFeedCard', { enabled: live });
  return live && definition && experiment.ready ? { event: definition.event } : null;
}
