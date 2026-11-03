import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * The one place the feed-card flag is read, together with the event being playable for this viewer
 * (the server's call, not the flag's). A later experiment segment can drive this hook alone.
 */
export function useHatTurfFeed(): { event: string } | null {
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration('Image', features.hatTurfFeedCard);
  return features.hatTurfFeedCard && definition ? { event: definition.event } : null;
}
