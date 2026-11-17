import { usePlayableEventDecoration } from '~/components/Decorations/usePlayableEventDecoration';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * The one place the image-detail flag is read, with the event being playable for this viewer and
 * the turf not being off. A signed-in viewer waits for the stock read (it carries the mode); a
 * signed-out one reads standings only, and the summaries come back empty when the turf is off.
 */
export function useHatTurfDetail(): { event: string } | null {
  const features = useFeatureFlags();
  const user = useCurrentUser();
  const definition = usePlayableEventDecoration('Image');
  const event = features.hatTurfImageDetail && definition ? definition.event : undefined;
  const { data: stock } = trpc.hatTurf.getStock.useQuery(
    { event: event ?? '' },
    { enabled: !!event && !!user, staleTime: 30_000 }
  );
  if (!event) return null;
  if (user && (!stock || stock.mode === 'off')) return null;
  return { event };
}
