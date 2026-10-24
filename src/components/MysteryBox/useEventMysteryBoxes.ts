import { useOptionalFeatureFlags } from '~/providers/FeatureFlagsProvider';
import { trpc } from '~/utils/trpc';

/**
 * An event's mystery boxes as the viewer sees them. Fetches nothing with the `mysteryBox` flag off,
 * or outside the flags provider (it fails closed there rather than throwing).
 */
export function useEventMysteryBoxes(event: string) {
  const features = useOptionalFeatureFlags();
  const { data } = trpc.mysteryBox.getForEvent.useQuery(
    { event },
    { enabled: !!features?.mysteryBox }
  );
  return data ?? [];
}

/**
 * An event's mystery boxes on sale, with base odds, for a viewer not on a team (signed out, or not
 * joined). Fetches nothing with the `mysteryBox` flag off, or until `enabled`.
 */
export function useEventMysteryBoxCatalog(event: string, enabled = true) {
  const features = useOptionalFeatureFlags();
  const { data } = trpc.mysteryBox.getCatalogForEvent.useQuery(
    { event },
    { enabled: enabled && !!features?.mysteryBox }
  );
  return data ?? [];
}
