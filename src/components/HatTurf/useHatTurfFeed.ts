import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';

/**
 * Whether Hat Turf shows on feed image cards for this viewer, and for which event, or null.
 *
 * The ONE place the feed-card flag is read: its own flag (apart from image detail's), plus the
 * event being playable for this viewer, which is the server's call and not the flag's. A later
 * experiment segment can drive this hook alone.
 */
export function useHatTurfFeed(): { event: string } | null {
  const features = useFeatureFlags();
  const definition = usePlayableEventDecoration('Image');
  return features.hatTurfFeedCard && definition ? { event: definition.event } : null;
}
